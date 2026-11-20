#!/usr/bin/env node
/**
 * jlc-kbc-mode — 把键盘灯效的位语义测干净，以便正确实现「固定色 / 呼吸」。
 *
 * 已有事实：
 *   MODE(0x0767) = 0x80  → 呼吸/循环（实机确认）
 *   MODE(0x0767) = 0x00  → 固定色，不呼吸（实机确认）
 *   R/G/B(0x0769/6a/6b)  → 通道值，渐变循环写入后灯确实变色（实机确认）
 * 未知：
 *   bit5(0x20, apply) 是不是写 RGB 的必要条件？
 *   设 bit5 后再置 bit7，呼吸会不会回来？
 *
 * 用法：sudo node probe/kbc-mode.mjs
 * 结束时一定恢复到「呼吸 + 原 RGB」。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-mode.json')
const CALL = '/proc/acpi/call'
const MODE = 0x0767
const RGB = [0x0769, 0x076a, 0x076b]
const RED = [0xff, 0x00, 0x00]

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}
const write = (a, v) => fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)
const setRgb = (c) => RGB.forEach((a, i) => write(a, c[i]))
const snap = () => ({mode: read(MODE), rgb: RGB.map(read)})

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-mode.mjs')
  process.exit(1)
}

const saved = snap()
console.log(`原始状态：MODE=${hex(saved.mode)}  RGB=${saved.rgb.map(hex).join(',')}`)
console.log('每步之后看一眼键盘，答一句就行。\n')

const STEPS = [
  {why: '写 RGB=纯红，但 MODE 保持 0x00（不设 apply 位）', run: () => { setRgb(RED); write(MODE, 0x00) }, ask: '变红了吗？（没变就是需要 apply 位）'},
  {why: 'MODE=0x20（只设 apply 位，不设循环位）', run: () => write(MODE, 0x20), ask: '现在是纯红色吗？'},
  {why: 'MODE=0xa0（apply + 循环位）', run: () => write(MODE, 0xa0), ask: '红色还固定着，还是开始循环了？'},
  {why: 'MODE=0x80（只留循环位，回到正常呼吸）', run: () => write(MODE, 0x80), ask: '呼吸回来了吗？'},
]

const rl = readline.createInterface({input: process.stdin, output: process.stdout})
const results = []

for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i]
  console.log(`── 第 ${i + 1}/${STEPS.length} 步：${s.why}`)
  await rl.question('   按回车执行…')
  s.run()
  await new Promise((r) => setTimeout(r, 300))
  const now = snap()
  console.log(`   回读：MODE=${hex(now.mode)}  RGB=${now.rgb.map(hex).join(',')}`)
  const obs = (await rl.question(`   ${s.ask} `)).trim()
  results.push({step: i + 1, why: s.why, after: now, observed: obs})
  console.log('')
}

// 无论结果如何，恢复到「呼吸 + 原始 RGB」
write(MODE, 0x80)
setRgb(saved.rgb)
const final = snap()
console.log(`已恢复：MODE=${hex(final.mode)}  RGB=${final.rgb.map(hex).join(',')}`)
rl.close()

console.log('\n──── 结果 ────')
for (const r of results) console.log(`  第${r.step}步 ${r.why}\n      MODE=${hex(r.after.mode)} RGB=${r.after.rgb.map(hex).join(',')} → ${r.observed || '（未记录）'}`)

fs.writeFileSync(OUT, JSON.stringify({schema: 1, at: new Date().toISOString(), saved, results}, null, 2) + '\n')
console.log(`\n明细：${OUT}`)
