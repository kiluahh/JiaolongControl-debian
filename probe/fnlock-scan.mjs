#!/usr/bin/env node
/**
 * jlc-fnlock-scan — Fn 锁到底归谁管：EC？键盘控制器？还是根本没有。
 *
 * 上一版（probe/fnlock.mjs）证明：按 Fn+Esc 时 0x074e 和 0x0740-0x0750 窗口
 * 一个字节都没变，F6 按键码也没变。两种可能：
 *   A. Fn+Esc 不是这台的切换键
 *   B. Fn 锁由键盘控制器自己管，EC 完全不参与（那软件就没法控制）
 *
 * 这个探针用两条独立证据分开它们：
 *   1. 按键事件：按组合键时 /dev/input/event0 有没有发出任何 keycode
 *      （有 → 键盘认识这个组合；没有 → 组合键被键盘吃掉，主机看不见）
 *   2. 全量 EC：0x0000-0x0FFF 前后对比（过滤噪声与易变地址）
 *      有变化 → EC 参与，可以软件控制；无变化 → EC 不参与
 *
 * 用法：
 *   sudo node probe/fnlock-scan.mjs              # 默认按 Fn+Esc
 *   sudo node probe/fnlock-scan.mjs "Fn+空格"    # 换组合键（提示语会跟着变）
 *
 * 只读，不写任何 EC 字节。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const OUT = path.join(import.meta.dirname, 'fnlock-scan.json')
const CALL = '/proc/acpi/call'
const LO = 0x0000
const HI = 0x0fff
const INTERNAL_KEYBOARD = 'AT Translated Set 2 keyboard'
const COMBO = process.argv[2] || 'Fn+Esc'
const CAPTURE_TIMEOUT_MS = 12000

/** 已知会被硬件自己刷新的地址（温度/转速/占空比/瞬时状态），对比时忽略 */
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
  465: 'FN_ESC',
  464: 'FN',
}

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const addr = (a) => '0x' + a.toString(16).padStart(4, '0')
const keyLabel = (c) => `${KEYNAME[c] ?? 'CODE_' + c}(${c})`

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  // 只接受单字节，EC 忙时返回 64 位垃圾值
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}

function dump(label) {
  const t0 = Date.now()
  process.stdout.write(`   dump ${label} … `)
  const out = new Uint8Array(HI - LO + 1)
  for (let a = LO; a <= HI; a++) out[a - LO] = read(a) ?? 0xff
  console.log(`${((Date.now() - t0) / 1000).toFixed(2)}s`)
  return out
}

const isVolatile = (a) => VOLATILE.some(([x, y]) => a >= x && a <= y)

/** 两轮 dump 的差异；noise 是"什么都不做也一直在变"的地址 */
function diff(base, other, noise) {
  const out = []
  for (let a = LO; a <= HI; a++) {
    const i = a - LO
    if (base[i] === other[i]) continue
    if (isVolatile(a)) continue
    if (noise.has(a)) continue
    out.push({addr: addr(a), before: hex(base[i]), after: hex(other[i])})
  }
  return out
}

function findEventNodes(wanted = INTERNAL_KEYBOARD) {
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
    if (name === wanted) found.push(path.join('/dev/input', entry))
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
    console.error('需要 root：sudo node probe/fnlock-scan.mjs')
    process.exit(1)
  }
  if (!fs.existsSync(CALL)) {
    console.error(`没有 ${CALL}：需要 acpi_call 模块`)
    process.exit(1)
  }
  const nodes = findEventNodes()
  if (!nodes.length) {
    console.error(`找不到 "${INTERNAL_KEYBOARD}" 的 event 节点`)
    process.exit(1)
  }
  const node = nodes[0]
  console.log(`内置键盘: ${node}`)
  console.log(`组合键: ${COMBO}\n`)

  const rl = readline.createInterface({input: process.stdin, output: process.stdout})
  const result = {combo: COMBO, eventNode: node, at: new Date().toISOString()}
  try {
    // ── 证据 1：组合键有没有进到主机 ──
    console.log('== 1. 组合键是否产生按键事件 ==')
    const pending = captureKeypress({node})
    console.log(`   请按一次 ${COMBO}（用笔记本自带键盘）…`)
    const captured = await pending
    result.keycodes = captured.codes
    if (captured.why === 'timeout') {
      console.log(`   ✗ ${CAPTURE_TIMEOUT_MS / 1000}s 内没有收到任何按键`)
      console.log('     → 这个组合被键盘自己吃掉了，主机看见的只是"什么都没发生"')
    } else {
      console.log(`   收到: ${captured.codes.map(keyLabel).join(', ')}`)
    }

    // ── 证据 2：EC 全量前后对比 ──
    console.log('\n== 2. 全量 EC 对比 ==')
    const a1 = dump('A1')
    const a2 = dump('A2')
    const noise = new Set()
    for (let a = LO; a <= HI; a++) if (a1[a - LO] !== a2[a - LO]) noise.add(a)
    console.log(`   空转噪声地址 ${noise.size} 个（两次连续 dump 自己就在变的）`)

    await rl.question(`   请按一次 ${COMBO}，然后回车…`)
    const b = dump('B')
    const changeAB = diff(a2, b, noise)
    console.log(`   A→B 变化: ${changeAB.length} 处`)
    for (const c of changeAB.slice(0, 20)) console.log(`     ${c.addr}: ${c.before} → ${c.after}`)

    await rl.question(`   再按一次 ${COMBO}（切回去），然后回车…`)
    const c = dump('C')
    const changeBC = diff(b, c, noise)
    console.log(`   B→C 变化: ${changeBC.length} 处`)
    for (const x of changeBC.slice(0, 20)) console.log(`     ${x.addr}: ${x.before} → ${x.after}`)

    const ecInvolved = changeAB.length > 0 || changeBC.length > 0
    const hostSeesCombo = captured.why === 'key' && captured.codes.length > 0
    result.changeAB = changeAB
    result.changeBC = changeBC
    result.ecInvolved = ecInvolved
    result.hostSeesCombo = hostSeesCombo

    console.log('\n== 结论 ==')
    if (ecInvolved) {
      const addrs = [...new Set([...changeAB, ...changeBC].map((x) => x.addr))]
      console.log(`   ✓ EC 参与 Fn 锁，变化地址: ${addrs.join(', ')}`)
      console.log('     → 可以按这些地址继续定位状态位（下一步写探针）')
      result.conclusion = `EC 参与，候选地址 ${addrs.join(', ')}`
    } else if (hostSeesCombo) {
      console.log(`   ⚠ 组合键有事件（${captured.codes.map(keyLabel).join(', ')}）但 EC 无变化`)
      console.log('     → Fn 锁状态不在 EC 里，主机只能看到"按了一下"')
      result.conclusion = '组合键有事件、EC 无变化：状态不在 EC RAM'
    } else {
      console.log('   ✗ 组合键既没有按键事件，也没有 EC 变化')
      console.log('     → 这个组合不是切换键（或本机没有 Fn 锁），换组合再测')
      result.conclusion = '组合键无效：既无按键事件也无 EC 变化'
    }
    result.pass = ecInvolved
    save(result)
    process.exit(ecInvolved ? 0 : 1)
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
