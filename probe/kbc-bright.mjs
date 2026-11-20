#!/usr/bin/env node
/**
 * jlc-kbc-bright — 试探 0x078c 的背光亮度语义。
 *
 * 当前值 0x80。依次写 0x80|level(0..3) 与 0x00，各停 3 秒，观察背光亮度变化。
 * 结束后恢复原值。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const STEP_MODE = process.argv.includes('--step')

const CALL = '/proc/acpi/call'
const REG = {BL: 0x078c, MODE: 0x0767}
const STEPS = [
  {v: 0x80, why: '原值（对照）'},
  {v: 0x81, why: 'level 1'},
  {v: 0x82, why: 'level 2'},
  {v: 0x83, why: 'level 3'},
  {v: 0x00, why: '关灯候选'},
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

const saved = ecRead(REG.BL)
console.log(`当前 0x078c = ${hex(saved)}，mode=${hex(ecRead(REG.MODE))}\n`)

if (STEP_MODE) console.log('交互模式：每次按回车进入下一档，看清当前亮度后再按。\n')
const rl = STEP_MODE ? readline.createInterface({input: process.stdin, output: process.stdout}) : null

for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i]
  if (rl) await rl.question(`按回车 → 写入 ${hex(s.v)}（${s.why}）`)
  ecWrite(REG.BL, s.v)
  if (rl) await rl.question(`   已写入 ${hex(s.v)}，看清后按回车继续`)
  else await sleep(3000)
  const back = ecRead(REG.BL)
  console.log(`步骤 ${i + 1}/${STEPS.length}  写 ${hex(s.v)}（${s.why}） → 回读 ${hex(back)}${back === s.v ? ' 保持' : ' 被改写'}`)
}
if (rl) rl.close()

ecWrite(REG.BL, saved)
console.log(`\n已恢复 0x078c = ${hex(saved)}`)
