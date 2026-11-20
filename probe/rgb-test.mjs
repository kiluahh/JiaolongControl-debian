#!/usr/bin/env node
/**
 * jlc-rgb-test — 键盘 RGB 颜色写入验证（可回滚）
 *
 * 依据：0x0767 bit5(0x20)=应用颜色、bit7(0x80)=彩虹；0x0769/0x076a/0x076b = R/G/B。
 * 流程：红 → 绿 → 蓝 → 回滚原色与原模式。
 *
 * 用法：sudo node probe/rgb-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'rgb-test.json')
const CALL = '/proc/acpi/call'

const REG = {MODE: 0x0767, R: 0x0769, G: 0x076a, B: 0x076b, BL: 0x078c}
const APPLY = 0x20 // bit5：应用颜色
const RAINBOW = 0x80 // bit7：彩虹模式

const COLORS = [
  {name: '红', r: 0xff, g: 0x00, b: 0x00},
  {name: '绿', r: 0x00, g: 0xff, b: 0x00},
  {name: '蓝', r: 0x00, g: 0x00, b: 0xff},
]

const log = []
const rec = (s) => {
  log.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`)
  process.stderr.write(s + '\n')
}

function ecRead(addr) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${addr.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  if (!m) throw new Error(`ECRR 0x${addr.toString(16)} → ${JSON.stringify(t.slice(0, 40))}`)
  return parseInt(m[1], 16)
}

const ecWrite = (addr, v) =>
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${addr.toString(16)} 0x${(v & 0xff).toString(16)}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (v) => '0x' + v.toString(16).padStart(2, '0')

let saved = null
let done = false

function restore() {
  if (!saved || done) return
  done = true
  try {
    ecWrite(REG.R, saved.r)
    ecWrite(REG.G, saved.g)
    ecWrite(REG.B, saved.b)
    ecWrite(REG.MODE, saved.mode)
    rec(`已还原 mode=${hex(saved.mode)} rgb=${saved.r},${saved.g},${saved.b}`)
  } catch (e) {
    rec(`还原失败: ${e.message}`)
    rec(`手工: sudo sh -c 'echo "\\\\_SB.INOU.ECRW 0x0767 ${hex(saved?.mode ?? 0)}" > /proc/acpi/call'`)
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

const report = {schema: 1, at: new Date().toISOString(), steps: [], error: null, log}

try {
  if (process.getuid?.() !== 0) throw new Error('需要 root：sudo node probe/rgb-test.mjs')
  if (!fs.existsSync(CALL)) throw new Error('/proc/acpi/call 不存在')

  saved = {
    mode: ecRead(REG.MODE),
    r: ecRead(REG.R),
    g: ecRead(REG.G),
    b: ecRead(REG.B),
    bl: ecRead(REG.BL),
  }
  rec(`原值 mode=${hex(saved.mode)} rgb=${saved.r},${saved.g},${saved.b} brightness=${hex(saved.bl)}`)
  rec(`  bit5(应用颜色)=${saved.mode & APPLY ? '是' : '否'} bit7(彩虹)=${saved.mode & RAINBOW ? '是' : '否'}`)

  for (const c of COLORS) {
    rec(`写入「${c.name}」rgb=${c.r},${c.g},${c.b}`)
    ecWrite(REG.R, c.r)
    ecWrite(REG.G, c.g)
    ecWrite(REG.B, c.b)
    // 退出彩虹 + 置应用位
    const mode = (saved.mode & ~RAINBOW) | APPLY
    ecWrite(REG.MODE, mode)
    await sleep(1500)
    const rb = {mode: ecRead(REG.MODE), r: ecRead(REG.R), g: ecRead(REG.G), b: ecRead(REG.B)}
    report.steps.push({color: c.name, written: {mode, ...c}, readBack: rb})
    rec(`  回读 mode=${hex(rb.mode)} rgb=${rb.r},${rb.g},${rb.b}${rb.mode === mode && rb.r === c.r && rb.g === c.g && rb.b === c.b ? '' : ' ⚠️ 与写入不符'}`)
  }
} catch (e) {
  report.error = String(e.message ?? e)
  rec(`错误: ${report.error}`)
} finally {
  restore()
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
process.stdout.write('\n' + log.join('\n') + '\n')
