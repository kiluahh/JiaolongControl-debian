#!/usr/bin/env node
/**
 * jlc-fnlock — 确认 Fn 锁在 EC 里的位置，并验证能否从软件写入。
 *
 * 依据：TUXEDO GPL 驱动 uniwill_keyboard.h
 *   #define UW_EC_REG_KBD_FN_LOCK_STATUS_BIT  0x074e
 *   #define UNIWILL_FN_LOCK_MASK               0x10   (bit4)
 *   get: 读 0x074e，取 bit4
 *   set: 读 0x074e → set/clear bit4 → 原样写回（没有额外的触发字节）
 *
 * 三步验证，每步都要你确认"按 F1 看到的是什么"：
 *   1. 只读基线：现在 F1 是功能键(f)还是媒体键(m)？
 *   2. 按 Fn+Esc 后再读：0x074e 有没有翻 bit4？行为跟着翻了吗？
 *   3. 软件写入 bit4：行为跟着软件写的值走了吗？（结束一定恢复原始值）
 *
 * 用法：sudo node probe/fnlock.mjs
 * 只写 0x074e，且始终保留其余位；结束时写回原始字节。
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

const isFn = (s) => /^(f|fn|功能|功能键)$/i.test(String(s).trim())
const isMedia = (s) => /^(m|media|媒体|媒体键)$/i.test(String(s).trim())

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const addr = (a) => '0x' + a.toString(16).padStart(4, '0')

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  // EC 忙时可能返回 64 位垃圾，只接受单字节
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
  const changed = []
  for (let x = LO; x <= HI; x++) {
    if (a[x] !== b[x]) changed.push({addr: addr(x), before: hex(a[x]), after: hex(b[x])})
  }
  return changed
}

const bit = (v) => (v === null ? null : (v & MASK) >>> 4)

function line(label, v) {
  console.log(`   ${label}: ${addr(REG)}=${hex(v)}  bit4=${bit(v)}`)
}

function save(data) {
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2))
  console.log(`\n证据: ${OUT}`)
}

async function askMode(rl, q) {
  for (;;) {
    const a = (await rl.question(q)).trim()
    if (isFn(a)) return 'fn'
    if (isMedia(a)) return 'media'
    console.log('   请输入 f（功能键）或 m（媒体键）')
  }
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

  const original = read(REG)
  if (original === null) {
    console.error('读 0x074e 失败，EC 不可用')
    process.exit(1)
  }

  console.log('== 0. 当前状态 ==')
  line('0x074e', original)
  console.log('   （bit4 = Fn 锁；TUXEDO 定义 UNIWILL_FN_LOCK_MASK=0x10）')

  const rl = readline.createInterface({input: process.stdin, output: process.stdout})
  let modified = false
  const result = {reg: addr(REG), mask: hex(MASK), original: hex(original), steps: {}}
  try {
    console.log('\n== 1. 只读基线 ==')
    console.log('   现在按一下 F1 键（不要按 Fn），观察实际效果。')
    const baseMode = await askMode(rl, '   F1 是？(f=F1 功能键 / m=媒体键，如亮度/音量) ')
    result.steps.baseline = {mode: baseMode, reg: hex(original), bit4: bit(original)}

    console.log('\n== 2. Fn+Esc 热键（只读验证）==')
    const beforeHotkey = dump()
    await rl.question('   请按一次 Fn+Esc 切换 Fn 锁，然后回车…')
    const afterHotkey = dump()
    const changed = diff(beforeHotkey, afterHotkey)
    line('F1 锁寄存器', afterHotkey[REG])
    if (changed.length === 0) {
      console.log('   ✗ 窗口内没有任何字节变化：Fn+Esc 没写 EC（可能由固件/键盘自己处理）')
    } else {
      for (const c of changed) console.log(`   变化: ${c.addr}: ${c.before} → ${c.after}`)
    }
    const hotkeyMode = await askMode(rl, '   再按一下 F1，现在是？(f/m) ')
    const bitFlipped = bit(afterHotkey[REG]) !== bit(original)
    const modeFlipped = hotkeyMode !== baseMode
    result.steps.hotkey = {
      changed,
      before: hex(beforeHotkey[REG]),
      after: hex(afterHotkey[REG]),
      mode: hotkeyMode,
      bitFlipped,
      modeFlipped,
    }
    console.log(
      `   结论: bit4 翻转=${bitFlipped ? '是' : '否'}，行为翻转=${modeFlipped ? '是' : '否'}` +
        ` → ${bitFlipped && modeFlipped ? '✓ 0x074e bit4 就是 Fn 锁状态' : '⚠ 需要看写入测试'}`,
    )

    // 安全闸：只有热键确实改写了 0x074e 的 bit4，才做写入测试。
    // 否则说明位置推错了，盲目写别的位可能动到无关硬件状态。
    if (!bitFlipped) {
      result.pass = false
      result.conclusion = 'Fn+Esc 没有改变 0x074e bit4，不冒险做写入测试'
      console.log(`\n== 结论 ==\n   ${result.conclusion}`)
      save(result)
      process.exit(1)
    }

    console.log('\n== 3. 软件写入验证 ==')
    const current = read(REG)
    const target = current & MASK ? current & ~MASK : current | MASK
    console.log(`   写入 ${addr(REG)}: ${hex(current)} → ${hex(target)}（只翻 bit4，其余位不变）`)
    write(REG, target)
    modified = true
    await new Promise((r) => setTimeout(r, 200))
    const afterWrite = read(REG)
    line('写入后回读', afterWrite)
    const writeMode = await askMode(rl, '   现在再按一下 F1，是？(f/m) ')
    // 期望：写入的 bit 与实际行为一致（bit4=1 通常表示 Fn 锁开启，具体哪个模式以你观察为准）
    const writeFlipped = writeMode !== hotkeyMode
    result.steps.write = {
      before: hex(current),
      target: hex(target),
      after: hex(afterWrite),
      mode: writeMode,
      modeFlipped: writeFlipped,
      applied: (afterWrite & MASK) === (target & MASK),
    }
    console.log(
      `   回读${result.steps.write.applied ? '一致' : '不一致'}，行为${writeFlipped ? '跟着变了' : '没变'}` +
        ` → ${writeFlipped ? '✓ 软件可写' : '✗ 写了但行为没变'}`,
    )

    console.log('\n== 4. 恢复 ==')
    write(REG, original)
    await new Promise((r) => setTimeout(r, 200))
    const restored = read(REG)
    line('恢复后', restored)
    result.steps.restore = {value: hex(restored), ok: restored === original}
    console.log(`   ${restored === original ? '✓ 已恢复原始值' : '✗ 恢复失败，请手动按 Fn+Esc 对齐'}`)

    // 位语义：把"看到的行为"和"读到的 bit4"配对，得出 1/0 各代表什么
    const semantics = {}
    for (const [b, m] of [
      [bit(original), baseMode],
      [bit(afterHotkey[REG]), hotkeyMode],
      [bit(afterWrite), writeMode],
    ]) {
      if (b === 0 || b === 1) (semantics[b] ??= []).push(m)
    }
    result.semantics = Object.fromEntries(
      Object.entries(semantics).map(([b, ms]) => [b, [...new Set(ms)].join('|')]),
    )
    const sem = Object.entries(result.semantics)
      .map(([b, ms]) => `bit4=${b} → ${ms}`)
      .join('，')
    if (sem) console.log(`   位语义: ${sem}`)

    const pass = bitFlipped && modeFlipped && writeFlipped
    result.pass = pass
    result.conclusion = pass
      ? 'Fn 锁 = 0x074e bit4，读和写都成立'
      : bitFlipped && modeFlipped
        ? '读数成立，但软件写入没有改变行为'
        : '0x074e bit4 与本机 Fn 锁不对应，需要继续找'
    console.log(`\n== 结论 ==\n   ${result.conclusion}`)
    save(result)
    process.exit(pass ? 0 : 1)
  } finally {
    rl.close()
    if (modified) {
      try {
        write(REG, original)
        console.log(`\n[safety] 已确保写回 ${addr(REG)}=${hex(original)}`)
      } catch (e) {
        console.error(`[safety] 恢复失败: ${e.message}，请手动按 Fn+Esc`)
      }
    }
  }
}

main()
