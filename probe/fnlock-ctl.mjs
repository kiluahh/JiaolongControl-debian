#!/usr/bin/env node
/**
 * jlc-fnlock-ctl — 对照实验：把"按键副作用"和"Fn 锁状态位"分开。
 *
 * 上一轮（fnlock-scan）按 Fn+Esc 后 EC 有 8 个地址变化，但没法定性：
 * 按任何键都可能让 EC 动（按键计数、键盘矩阵、电源状态…）。
 * 而且这些地址在 TUXEDO / MECHREVO 源码里全都没定义。
 *
 * 本探针按顺序做四次单键操作，每次前后各 dump 一次全量 EC：
 *   1. 单按 Esc     ← 纯按键副作用基线
 *   2. 单按 F6      ← 纯按键副作用基线（不同键）
 *   3. 按 Fn+F6    ← 验证 Fn 翻译链路是否通（应出现亮度键码）
 *   4. 按 Fn+Esc   ← 待测组合
 * 然后等 2s 再 dump 一次（区分"瞬时变化"与"稳定状态"），再按一次 Fn+Esc 看是否翻回。
 *
 * 关键判据：
 *   状态位 = 只被 Fn+Esc 改动 + 等待后保持不变 + 再按一次翻回
 *   副作用 = 单按 Esc/F6 也会动，或 2s 后自己恢复
 *
 * 用法：sudo node probe/fnlock-ctl.mjs
 * 只读，不写任何 EC 字节。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const OUT = path.join(import.meta.dirname, 'fnlock-ctl.json')
const CALL = '/proc/acpi/call'
const LO = 0x0000
const HI = 0x0fff
const INTERNAL_KEYBOARD = 'AT Translated Set 2 keyboard'
const CAPTURE_TIMEOUT_MS = 12000

const VOLATILE = [
  [0x043e, 0x043e],
  [0x044f, 0x044f],
  [0x0464, 0x046f],
  [0x04a0, 0x04af],
  [0x0751, 0x0751],
  [0x1804, 0x1809],
]

const KEYNAME = {
  1: 'ESC',
  59: 'F1',
  60: 'F2',
  61: 'F3',
  62: 'F4',
  63: 'F5',
  64: 'F6',
  65: 'F7',
  66: 'F8',
  67: 'F9',
  68: 'F10',
  69: 'F11',
  70: 'F12',
  113: 'MUTE',
  114: 'VOLUMEDOWN',
  115: 'VOLUMEUP',
  224: 'BRIGHTNESSDOWN',
  225: 'BRIGHTNESSUP',
}

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const addr = (a) => '0x' + a.toString(16).padStart(4, '0')
const keyLabel = (c) => `${KEYNAME[c] ?? 'CODE_' + c}(${c})`

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}

function dump(label) {
  process.stdout.write(`   dump ${label} … `)
  const out = new Uint8Array(HI - LO + 1)
  for (let a = LO; a <= HI; a++) out[a - LO] = read(a) ?? 0xff
  console.log('done')
  return out
}

const isVolatile = (a) => VOLATILE.some(([x, y]) => a >= x && a <= y)

function changes(base, other, noise) {
  const out = []
  for (let a = LO; a <= HI; a++) {
    const i = a - LO
    if (base[i] === other[i]) continue
    if (isVolatile(a) || noise.has(a)) continue
    out.push({addr: addr(a), before: hex(base[i]), after: hex(other[i])})
  }
  return out
}

function findEventNodes() {
  const base = '/sys/class/input'
  const found = []
  for (const entry of fs.readdirSync(base)) {
    if (!/^event\d+$/.test(entry)) continue
    let name = null
    try {
      name = fs.readFileSync(path.join(base, entry, 'device', 'name'), 'utf8').trim()
    } catch {
      continue
    }
    if (name === INTERNAL_KEYBOARD) found.push(path.join('/dev/input', entry))
  }
  return found
}

function captureKeypress({node, timeoutMs = CAPTURE_TIMEOUT_MS}) {
  return new Promise((resolve, reject) => {
    const codes = []
    const stream = fs.createReadStream(node)
    let pending = Buffer.alloc(0)
    let done = false
    const finish = (why) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.destroy()
      resolve({codes: [...new Set(codes)], why})
    }
    stream.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 24) {
        const rec = pending.subarray(0, 24)
        pending = pending.subarray(24)
        const type = rec.readUInt16LE(16)
        const code = rec.readUInt16LE(18)
        const value = rec.readInt32LE(20)
        if (type === 1 && value === 1 && code !== 0) {
          codes.push(code)
          setTimeout(() => finish('key'), 200)
        }
      }
    })
    stream.on('error', reject)
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
  })
}

function save(data) {
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2))
  console.log(`\n证据: ${OUT}`)
}

async function main() {
  if (process.getuid?.() !== 0) {
    console.error('需要 root：sudo node probe/fnlock-ctl.mjs')
    process.exit(1)
  }
  const nodes = findEventNodes()
  if (!nodes.length) {
    console.error('找不到内置键盘 event 节点')
    process.exit(1)
  }
  const node = nodes[0]
  const rl = readline.createInterface({input: process.stdin, output: process.stdout})
  const result = {eventNode: node, steps: {}, at: new Date().toISOString()}

  const pressAndDiff = async (label, prompt, prev) => {
    const pending = captureKeypress({node})
    console.log(`\n== ${label} ==`)
    console.log(`   ${prompt}`)
    const captured = await pending
    const keys = captured.codes.map(keyLabel).join(', ') || `(无按键事件, ${captured.why})`
    console.log(`   主机收到: ${keys}`)
    const cur = dump(label)
    const diff = changes(prev, cur, NOISE)
    console.log(`   EC 变化: ${diff.length} 处`)
    for (const c of diff) console.log(`     ${c.addr}: ${c.before} → ${c.after}`)
    result.steps[label] = {keycodes: captured.codes, keys, changes: diff}
    return cur
  }

  let NOISE = new Set()
  try {
    console.log('== 建立噪声基线 ==')
    const a1 = dump('A1')
    const a2 = dump('A2')
    for (let a = LO; a <= HI; a++) if (a1[a - LO] !== a2[a - LO]) NOISE.add(a)
    console.log(`   空转噪声地址 ${NOISE.size} 个`)

    let cur = await pressAndDiff('单按Esc', '请按一下 Esc（不按 Fn）', a2)
    cur = await pressAndDiff('单按F6', '请按一下 F6（不按 Fn）', cur)
    cur = await pressAndDiff('FnF6', '请按 Fn+F6（应该能调亮度）', cur)
    cur = await pressAndDiff('FnEsc', '请按 Fn+Esc', cur)

    // 等 2s 再 dump：区分瞬时变化与稳定状态
    console.log('\n== 等待 2s，看哪些变化是"稳定状态" ==')
    await new Promise((r) => setTimeout(r, 2000))
    const settle = dump('Settle')
    const settleDiff = changes(cur, settle, NOISE)
    console.log(`   2s 内自己恢复的地址: ${settleDiff.length} 处`)
    for (const c of settleDiff) console.log(`     ${c.addr}: ${c.before} → ${c.after}（瞬时）`)
    result.steps.Settle = {changes: settleDiff}

    const last = await pressAndDiff('FnEsc2', '请再按一次 Fn+Esc（切回去）', settle)

    // ── 交叉分析 ──
    const addrsOf = (step) => new Set(result.steps[step].changes.map((c) => c.addr))
    const esc = addrsOf('单按Esc')
    const f6 = addrsOf('单按F6')
    const fne = addrsOf('FnEsc')
    const fnf6 = addrsOf('FnF6')
    const instant = new Set(settleDiff.map((c) => c.addr))
    const all = [...new Set([...esc, ...f6, ...fne, ...fnf6])].sort()

    console.log('\n== 交叉分析 ==')
    console.log('   地址      单按Esc  单按F6  Fn+F6  Fn+Esc  2s后恢复')
    const candidates = []
    for (const a of all) {
      const m = (s) => (s.has(a) ? '  ✓   ' : '  ·   ')
      const row = `${a}  ${m(esc)}${m(f6)}${m(fnf6)}${m(fne)}${instant.has(a) ? '  是' : '  否'}`
      console.log('   ' + row)
      // 候选状态位：只在 Fn+Esc 出现、且 2s 后没有自己恢复
      if (fne.has(a) && !esc.has(a) && !f6.has(a) && !fnf6.has(a) && !instant.has(a)) candidates.push(a)
    }
    result.matrix = Object.fromEntries(
      all.map((a) => [
        a,
        {esc: esc.has(a), f6: f6.has(a), fnf6: fnf6.has(a), fnEsc: fne.has(a), instant: instant.has(a)},
      ]),
    )
    result.candidates = candidates

    console.log('\n== 结论 ==')
    if (candidates.length) {
      console.log(`   ✓ 候选状态位: ${candidates.join(', ')}`)
      console.log('     下一步：读这些地址的 bit，做写入测试')
      result.conclusion = `候选状态位 ${candidates.join(', ')}`
      result.pass = true
    } else {
      console.log('   ✗ 没有"只由 Fn+Esc 改动且稳定"的地址')
      console.log('     → EC 里没有可用的 Fn 锁状态；Fn+Esc 的变化都是按键副作用')
      result.conclusion = 'EC 中没有稳定的 Fn 锁状态位'
      result.pass = false
    }
    save(result)
    process.exit(result.pass ? 0 : 1)
  } catch (e) {
    console.error(`\n失败: ${e.message}`)
    result.error = e.message
    save(result)
    process.exit(1)
  } finally {
    rl.close()
  }
}

main()
