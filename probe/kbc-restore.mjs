#!/usr/bin/env node
/**
 * jlc-kbc-restore — 把键盘背光从「渐变残留色」恢复成原本的呼吸/循环状态。
 *
 * 背景：daemon 的渐变循环每 120 ms 往 0x0769/0x076a/0x076b 写 RGB，
 * 并在 0x0767 上置 bit5（apply）。循环被杀掉时最后一套颜色留在了寄存器里，
 * 灯就固定成那个颜色、不再循环。
 *
 * 0x0767 的实测值：14:27（未跑渐变）= 0x80，15:17（跑渐变）= 0xa0。
 * 所以第一步就是清掉 bit5、把 RGB 通道归零，看是否恢复。
 *
 * 用法：sudo node probe/kbc-restore.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-restore.json')
const CALL = '/proc/acpi/call'
const REG = {MODE: 0x0767, R: 0x0769, G: 0x076a, B: 0x076b, BL: 0x078c}

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}

function write(a, v) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)
}

function snapshot() {
  return Object.fromEntries(Object.entries(REG).map(([k, a]) => [k, read(a)]))
}

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-restore.mjs')
  process.exit(1)
}

/** 候选恢复动作，按「最可能正确 → 兜底」排序 */
const STEPS = [
  {why: '回到渐变前的原值：MODE=0x80（清掉 apply 位）', writes: [[REG.MODE, 0x80]]},
  {why: 'RGB 三通道归零', writes: [[REG.R, 0x00], [REG.G, 0x00], [REG.B, 0x00]]},
  {why: 'MODE=0x00（完全关掉固定色模式）', writes: [[REG.MODE, 0x00]]},
  {why: 'MODE=0xc0 且 RGB 全白（最后一招）', writes: [[REG.MODE, 0xc0], [REG.R, 0xff], [REG.G, 0xff], [REG.B, 0xff]]},
]

const before = snapshot()
const fmtSnap = (s) => Object.entries(s).map(([k, v]) => `${k}=${hex(v)}`).join('  ')
console.log(`当前状态：${fmtSnap(before)}`)
console.log('（MODE 的 bit5 是渐变循环加的 apply 位；RGB 是渐变留下的最后一套颜色）\n')

const rl = readline.createInterface({input: process.stdin, output: process.stdout})
const results = []

for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i]
  console.log(`── 第 ${i + 1} 步：${s.why}`)
  await rl.question('   按回车执行…')
  for (const [a, v] of s.writes) write(a, v)
  const after = snapshot()
  console.log(`   写入后：${fmtSnap(after)}`)
  const obs = (await rl.question('   键盘现在什么样？（说一句，例如"呼吸回来了"/"还是红色"/"灭了"） ')).trim()
  results.push({step: i + 1, why: s.why, after, observed: obs})
  if (/回来|正常|呼吸|好了|循环|对/.test(obs) && !/没|不/.test(obs)) {
    console.log('\n→ 已恢复，停止后续步骤。')
    break
  }
  console.log('')
}
rl.close()

console.log('\n──── 结果 ────')
for (const r of results) console.log(`  第${r.step}步 ${r.why}\n      → ${r.observed || '（未记录）'}`)

fs.writeFileSync(
  OUT,
  JSON.stringify({schema: 1, at: new Date().toISOString(), before, results}, null, 2) + '\n',
)
console.log(`\n明细：${OUT}`)
console.log('如果全部步骤都没能恢复，关机后再开机（冷启动）会让 EC 重新初始化，一定回到出厂灯效。')
