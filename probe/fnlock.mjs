#!/usr/bin/env node
/**
 * jlc-fnlock — 确认 Fn 锁在 EC 里的位置，并验证能否从软件写入。
 *
 * 判据不靠"看得见的效果"（F1 在桌面上本来就没反应），而是直接读内置键盘的
 * /dev/input/eventX：同一颗 F6，在两种 Fn 锁状态下发出的 keycode 不同
 *   F6 功能模式 → code 64  (KEY_F6)
 *   媒体模式     → code 224/225 (BRIGHTNESSDOWN/UP)、113/114/115 (MUTE/VOL)
 * 所以"按一下 F6，看发出哪个码"就是客观判据，不需要桌面有反应。
 *
 * 依据（TUXEDO GPL 驱动 uniwill_keyboard.h）：
 *   0x074e bit4 = Fn 锁；set = 读 → 翻 bit4 → 原样写回，没有额外触发字节
 *
 * 流程：
 *   1. 基线：F6 发出的码 + 0x074e 的 bit4
 *   2. Fn+Esc 切换后：两者是否一起变化
 *   3. 软件写 bit4：F6 的码是否跟着软件写走了
 *   4. 写回原始值
 *
 * 用法：sudo node probe/fnlock.mjs
 * 只写 0x074e 且只翻 bit4；结束一定恢复原始字节。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const OUT = path.join(import.meta.dirname, 'fnlock.json')
const CALL = '/proc/acpi/call'
const REG = 0x074e
const MASK = 0x10
const LO = 0x0740
const HI = 0x0750
const INTERNAL_KEYBOARD = 'AT Translated Set 2 keyboard'
const PROBE_KEY = 'F6'
const PROBE_CODE = 64
const CAPTURE_TIMEOUT_MS = 12000

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
  152: 'POWER?',
  224: 'BRIGHTNESSDOWN',
  225: 'BRIGHTNESSUP',
  240: 'UNKNOWN240',
}

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const addr = (a) => '0x' + a.toString(16).padStart(4, '0')
const bit = (v) => (v === null ? null : (v & MASK) >>> 4)
const keyLabel = (code) => `${KEYNAME[code] ?? 'CODE_' + code}(${code})`

/** keycode → 属于哪种模式；功能键 59..70 视为 function，其余视为媒体/特殊 */
function classify(codes) {
  if (!codes.length) return 'none'
  if (codes.some((c) => c >= 59 && c <= 70)) return 'function'
  return 'media'
}

// ── EC ──────────────────────────────────────────────────────────────────────
function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}

function write(a, v) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)
}

function dump() {
  const out = {}
  for (let a = LO; a <= HI; a++) out[a] = read(a)
  return out
}

function diff(a, b) {
  const out = []
  for (let x = LO; x <= HI; x++) if (a[x] !== b[x]) out.push({addr: addr(x), before: hex(a[x]), after: hex(b[x])})
  return out
}

// ── 键盘事件 ────────────────────────────────────────────────────────────────
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
    if (name === wanted) found.push({node: path.join('/dev/input', entry), name})
  }
  return found
}

/** 读按键事件：struct input_event{x86_64} = timeval(16) + u16 type + u16 code + s32 value = 24B */
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
          // 收到第一个按下后多等 150ms 收集同一击里的伴随码，然后结束
          setTimeout(() => finish('key'), 150)
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
    console.error('需要 root：sudo node probe/fnlock.mjs')
    process.exit(1)
  }
  if (!fs.existsSync(CALL)) {
    console.error(`没有 ${CALL}：需要 acpi_call 模块（sudo modprobe acpi_call）`)
    process.exit(1)
  }

  console.log('== 0. 找内置键盘的事件节点 ==')
  const nodes = findEventNodes()
  if (!nodes.length) {
    console.error(`   找不到 "${INTERNAL_KEYBOARD}" 的 event 节点`)
    process.exit(1)
  }
  for (const n of nodes) console.log(`   ${n.node}  ←  ${n.name}`)
  const node = nodes[0].node

  const original = read(REG)
  if (original === null) {
    console.error('   读 0x074e 失败，EC 不可用')
    process.exit(1)
  }
  console.log(`   0x074e = ${hex(original)}  bit4=${bit(original)}`)

  const rl = readline.createInterface({input: process.stdin, output: process.stdout})
  const result = {reg: addr(REG), mask: hex(MASK), original: hex(original), eventNode: node, steps: {}}
  let modified = false

  const sampleKey = async (label) => {
    // 先开始监听再提示，避免用户手快、按键发生在打开设备之前
    const pending = captureKeypress({node})
    console.log(`   请用【笔记本自带键盘】按一下 ${PROBE_KEY}${label}`)
    const {codes, why} = await pending
    if (why === 'timeout') {
      console.log(`   ✗ ${CAPTURE_TIMEOUT_MS / 1000}s 内没收到按键（是不是按了外接键盘？）`)
      return {codes: [], mode: 'none', timedOut: true}
    }
    const mode = classify(codes)
    console.log(`   收到: ${codes.map(keyLabel).join(', ')} → ${mode === 'function' ? '功能键码' : '媒体/特殊码'}`)
    return {codes, mode, timedOut: false}
  }

  try {
    console.log('\n== 1. 基线 ==')
    const base = await sampleKey('（不要按 Fn）')
    if (base.timedOut) throw new Error('基线没收到按键，先确认键盘事件节点对不对')
    result.steps.baseline = {codes: base.codes, mode: base.mode, bit4: bit(original)}

    console.log('\n== 2. Fn+Esc 热键（只读）==')
    const beforeHotkey = dump()
    await rl.question('   请按一次 Fn+Esc 切换 Fn 锁，然后回车…')
    const afterHotkey = dump()
    const changed = diff(beforeHotkey, afterHotkey)
    console.log(`   0x074e: ${hex(original)} → ${hex(afterHotkey[REG])}`)
    if (changed.length) for (const c of changed) console.log(`   变化: ${c.addr}: ${c.before} → ${c.after}`)
    else console.log('   ⚠ 窗口内没有任何字节变化（Fn+Esc 可能由固件自己处理）')

    const hot = await sampleKey('（依旧不按 Fn）')
    const bitFlipped = bit(afterHotkey[REG]) !== bit(original)
    const modeFlipped = !hot.timedOut && hot.mode !== base.mode
    result.steps.hotkey = {
      before: hex(original),
      after: hex(afterHotkey[REG]),
      changed,
      codes: hot.codes,
      mode: hot.mode,
      bitFlipped,
      modeFlipped,
    }
    console.log(`   结论: bit4 翻转=${bitFlipped ? '是' : '否'}，按键码翻转=${modeFlipped ? '是' : '否'}`)
    if (!(bitFlipped && modeFlipped)) {
      result.pass = false
      result.conclusion =
        'Fn+Esc 没有同时改变 0x074e bit4 和按键码 —— 位置不对或热键不是 Fn+Esc，未做写入'
      console.log(`\n== 结论 ==\n   ${result.conclusion}`)
      save(result)
      process.exit(1)
    }

    console.log('\n== 3. 软件写入验证 ==')
    const current = read(REG)
    const target = current & MASK ? current & ~MASK : current | MASK
    console.log(`   写入 ${addr(REG)}: ${hex(current)} → ${hex(target)}（只翻 bit4）`)
    write(REG, target)
    modified = true
    await new Promise((r) => setTimeout(r, 300))
    const afterWrite = read(REG)
    console.log(`   回读: ${hex(afterWrite)}  bit4=${bit(afterWrite)}`)
    const wr = await sampleKey('（依旧不按 Fn）')
    const writeFlipped = !wr.timedOut && wr.mode !== hot.mode
    result.steps.write = {
      before: hex(current),
      target: hex(target),
      after: hex(afterWrite),
      codes: wr.codes,
      mode: wr.mode,
      applied: bit(afterWrite) === bit(target),
      modeFlipped: writeFlipped,
    }
    console.log(`   按键码${writeFlipped ? '跟着变了' : '没变'} → ${writeFlipped ? '✓ 软件可写' : '✗ 写了但行为没变'}`)

    // 位语义：bit4=1/0 各对应哪种按键码
    const semantics = {}
    for (const [b, m] of [
      [bit(original), base.mode],
      [bit(afterHotkey[REG]), hot.mode],
      [bit(afterWrite), wr.mode],
    ]) {
      if ((b === 0 || b === 1) && m !== 'none') (semantics[b] ??= new Set()).add(m)
    }
    result.semantics = Object.fromEntries(Object.entries(semantics).map(([b, s]) => [b, [...s].join('|')]))
    const semText = Object.entries(result.semantics)
      .map(([b, m]) => `bit4=${b} → ${m === 'function' ? 'F1-F12 功能键' : '媒体键'}`)
      .join('，')
    if (semText) console.log(`   位语义: ${semText}`)

    console.log('\n== 4. 恢复 ==')
    write(REG, original)
    await new Promise((r) => setTimeout(r, 300))
    const restored = read(REG)
    result.steps.restore = {value: hex(restored), ok: restored === original}
    console.log(`   0x074e = ${hex(restored)}  ${restored === original ? '✓ 已恢复' : '✗ 恢复失败，请手动按 Fn+Esc 对齐'}`)

    const pass = bitFlipped && modeFlipped && writeFlipped
    result.pass = pass
    result.conclusion = pass
      ? 'Fn 锁 = 0x074e bit4，读和写都成立'
      : '读数成立但软件写入没改变按键码，需要改用别的触发方式'
    console.log(`\n== 结论 ==\n   ${result.conclusion}`)
    save(result)
    process.exit(pass ? 0 : 1)
  } catch (e) {
    console.error(`\n失败: ${e.message}`)
    result.error = e.message
    save(result)
    process.exit(1)
  } finally {
    rl.close()
    if (modified) {
      try {
        write(REG, original)
        console.log(`\n[safety] 已确保写回 ${addr(REG)}=${hex(original)}`)
      } catch (e) {
        console.error(`\n[safety] 恢复失败: ${e.message}，请手动按 Fn+Esc`)
      }
    }
  }
}

main()
