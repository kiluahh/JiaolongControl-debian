#!/usr/bin/env node
/**
 * jlc-kbc-modes — 扫描 0x0767 的合法模式值。
 *
 * 每步：写红色 RGB → 写一个候选 mode → 等 3.5 秒 → 回读。
 * 用户观察哪一步键盘变成稳定红色。
 *
 * 只动键盘灯相关寄存器（0x0767/0x0769-6b/0x078c），不碰风扇/功耗。
 * 结束时恢复原始值。
 *
 * 用法：sudo node probe/kbc-modes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-modes.json')
const CALL = '/proc/acpi/call'

const REG = {MODE: 0x0767, R: 0x0769, G: 0x076a, B: 0x076b, BL: 0x078c}

/** 候选模式值：固定色/关灯/带位组合 */
const CANDIDATES = [
  {v: 0x02, why: '上游枚举 Mode_RGBFixedMode'},
  {v: 0x00, why: 'Mode_Off'},
  {v: 0x82, why: '固定色 + 高位'},
  {v: 0x42, why: 'bit6'},
  {v: 0x22, why: 'bit5'},
  {v: 0x12, why: 'bit4'},
  {v: 0x0a, why: '低 nibble 组合'},
]

const ecRead = (a) => {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  return m ? parseInt(m[1], 16) : null
}
const ecWrite = (a, v) => fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)
const hex = (v) => (v === null ? '?' : '0x' + v.toString(16).padStart(2, '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.getuid?.() !== 0) {
  console.error('需要 root')
  process.exit(1)
}

const saved = {
  mode: ecRead(REG.MODE),
  r: ecRead(REG.R),
  g: ecRead(REG.G),
  b: ecRead(REG.B),
  bl: ecRead(REG.BL),
}
console.log(`原值: mode=${hex(saved.mode)} rgb=${saved.r},${saved.g},${saved.b} bl=${hex(saved.bl)}\n`)

const report = {schema: 1, at: new Date().toISOString(), saved, steps: []}

for (let i = 0; i < CANDIDATES.length; i++) {
  const c = CANDIDATES[i]
  console.log(`── 步骤 ${i + 1}/${CANDIDATES.length}: mode=${hex(c.v)}（${c.why}）──`)
  ecWrite(REG.R, 0xff)
  ecWrite(REG.G, 0x00)
  ecWrite(REG.B, 0x00)
  ecWrite(REG.MODE, c.v)
  await sleep(3500)
  const back = {mode: ecRead(REG.MODE), r: ecRead(REG.R), g: ecRead(REG.G), b: ecRead(REG.B)}
  report.steps.push({candidate: c, readBack: back})
  console.log(`   回读 mode=${hex(back.mode)} rgb=${back.r},${back.g},${back.b}${back.mode === c.v ? '（保持）' : '（被改写）'}`)
}

// 恢复
ecWrite(REG.R, saved.r)
ecWrite(REG.G, saved.g)
ecWrite(REG.B, saved.b)
ecWrite(REG.MODE, saved.mode)
ecWrite(REG.BL, saved.bl)
console.log(`\n已恢复 mode=${hex(saved.mode)}`)

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`明细: ${OUT}`)
