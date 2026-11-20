#!/usr/bin/env node
/**
 * jlc-kbc-power — 键盘背光开关的决定性验证（交互式）。
 *
 * 每写一个值都会停下来问你现在灯是亮还是灭，答案写进 probe/kbc-power.json。
 * 这样结论不依赖事后回忆，也不会被"太快看不清"干扰。
 *
 * 用法：sudo node probe/kbc-power.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-power.json')
const CALL = '/proc/acpi/call'
const REG = {BL: 0x078c, MODE: 0x0767}

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

const rl = readline.createInterface({input: process.stdin, output: process.stdout})
const ask = async (q) => (await rl.question(q)).trim().toLowerCase()
const lit = (ans) => (ans.startsWith('y') || ans.startsWith('是') ? '亮' : '灭')

const report = {schema: 1, at: new Date().toISOString(), state: {}, steps: []}
const before = {bl: ecRead(REG.BL), mode: ecRead(REG.MODE)}
report.state.initial = before
console.log(`起始: 0x078c=${hex(before.bl)} 0x0767=${hex(before.mode)}\n`)

const first = await ask('现在键盘灯是亮着的吗？(y/n) ')
console.log(`记录初始状态: ${lit(first)}\n`)

const trials = [
  {v: 0x02, desc: '关灯位（bit1）'},
  {v: 0x00, desc: '清零'},
  {v: 0x80, desc: '高位（原值）'},
  {v: 0x82, desc: '高位 + bit1'},
]

for (const t of trials) {
  ecWrite(REG.BL, t.v)
  await sleep(800)
  const back = ecRead(REG.BL)
  const ans = await ask(`已写入 0x078c = ${hex(t.v)}（${t.desc}），现在灯是亮的吗？(y/n) `)
  report.steps.push({written: t.v, desc: t.desc, readBack: back, lit: lit(ans)})
  console.log(`   回读 ${hex(back)} → 记录：${lit(ans)}\n`)
}

// 恢复初始值
ecWrite(REG.BL, before.bl)
rl.close()

console.log(`已恢复 0x078c=${hex(before.bl)}`)
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')

const s = report.steps
console.log('\n=== 结论 ===')
for (const st of s) console.log(`  写 ${hex(st.written)} → ${st.lit}`)
const offs = s.filter((x) => x.lit === '灭').map((x) => hex(x.written))
const ons = s.filter((x) => x.lit === '亮').map((x) => hex(x.written))
console.log(`  已知"灭"的值: ${offs.join(', ') || '无'}`)
console.log(`  已知"亮"的值: ${ons.join(', ') || '无'}`)
