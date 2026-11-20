#!/usr/bin/env node
/**
 * jlc-kbc-color — 颜色验证第二版：先退出呼吸模式，再触发 apply。
 *
 * 上一轮 kbc-apply 的发现：
 *   档位 0..4 全部通过（含关灯后重新点亮）——apply 位 0x10 是正确的。
 *   颜色写入后 0x0767 回读为 0x80，说明 bit5(APPLY_COLOR) 被 EC 执行后立刻清掉，
 *   是一次性触发；而当时 bit7(RAINBOW) 仍开着，呼吸会覆盖固定色。
 *
 * 所以颜色流程改为：
 *   1. 确保档位 4
 *   2. 写通道值 0x0769/6a/6b（0..50）
 *   3. 写 0x0767 = 0x20（清 bit7 退出呼吸 + bit5 触发 apply）
 *   4. 需要恢复呼吸时写 0x0767 = 0x80
 *
 * 用法：sudo node probe/kbc-color.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-color.json')
const CALL = '/proc/acpi/call'

const REG = {MODE: 0x0767, R: 0x0769, G: 0x076a, B: 0x076b, BL: 0x078c}
const BL_APPLY = 0x10
const MODE_APPLY_COLOR = 0x20
const MODE_RAINBOW = 0x80

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isYes = (s) => /^(y|yes|是|对|有|亮|红|绿|蓝|白|呼吸|嗯|ok)/i.test(String(s).trim())

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}
const write = (a, v) => fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)

function setLevel(level) {
  const cur = read(REG.BL) ?? 0
  write(REG.BL, (cur & 0x0f) | ((level & 0x07) << 5) | BL_APPLY)
}
const rgbToEc = (v) => Math.round((v * 200) / (255 * 4)) // 0..50

/** 写颜色：通道值(0..50) → 退出呼吸并触发 apply */
function setColor(r, g, b) {
  const ec = [rgbToEc(r), rgbToEc(g), rgbToEc(b)]
  write(REG.R, ec[0])
  write(REG.G, ec[1])
  write(REG.B, ec[2])
  // 清 bit7（退出呼吸）+ bit5（apply 触发）
  write(REG.MODE, MODE_APPLY_COLOR)
  return ec
}

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-color.mjs')
  process.exit(1)
}

let restored = false
function restore() {
  if (restored) return
  restored = true
  setLevel(4)
  write(REG.MODE, MODE_RAINBOW) // 回到呼吸
  write(REG.R, 0xff)
  write(REG.G, 0xff)
  write(REG.B, 0xff)
  console.log(`\n已恢复：档位 4 + 呼吸模式（MODE=${hex(read(REG.MODE))}）`)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130) })

const rl = readline.createInterface({input: process.stdin, output: process.stdout})
const results = []
const ask = async (q) => (await rl.question(`   ${q} `)).trim()

async function step(name, action, question) {
  console.log(`── ${name}`)
  await ask('按回车执行…')
  const info = action()
  await sleep(400)
  console.log(`   ${info ? info + '  ' : ''}回读 MODE=${hex(read(REG.MODE))} RGB=${[read(REG.R), read(REG.G), read(REG.B)].map(hex).join(',')} BL=${hex(read(REG.BL))}`)
  const answer = await ask(question)
  const pass = isYes(answer)
  results.push({name, answer, pass})
  console.log(`   ${pass ? '✔ PASS' : '✘ FAIL'}\n`)
  return pass
}

console.log('════ 颜色验证（退出呼吸后再 apply）════')
console.log(`初始 MODE=${hex(read(REG.MODE))} RGB=${[read(REG.R), read(REG.G), read(REG.B)].map(hex).join(',')} BL=${hex(read(REG.BL))}\n`)

// 0. 先确保档位 4 且灯亮
console.log('先把档位拉到 4 并点亮…')
setLevel(4)
await sleep(300)
console.log(`   0x078c=${hex(read(REG.BL))}\n`)

// 1~4. 四色
for (const [name, rgb, word] of [
  ['纯红', [255, 0, 0], '红'],
  ['纯绿', [0, 255, 0], '绿'],
  ['纯蓝', [0, 0, 255], '蓝'],
  ['纯白', [255, 255, 255], '白'],
]) {
  await step(
    `颜色：${name}（通道 ${rgbToEc(rgb[0])},${rgbToEc(rgb[1])},${rgbToEc(rgb[2])}）+ MODE=0x20`,
    () => setColor(rgb[0], rgb[1], rgb[2]),
    `现在是${word}色、并且还亮着吗？(y/n)`,
  )
}

// 5. 回到呼吸
await step('恢复呼吸：MODE=0x80', () => write(REG.MODE, MODE_RAINBOW), '回到呼吸/循环效果了吗？(y/n)')

rl.close()
restore()

console.log('════ 结果 ════')
for (const r of results) console.log(`  ${r.pass ? '✔' : '✘'} ${r.name.padEnd(44)} ${r.answer || '（未答）'}`)
console.log(`\n通过 ${results.filter((r) => r.pass).length}/${results.length}`)
fs.writeFileSync(OUT, JSON.stringify({schema: 1, at: new Date().toISOString(), results}, null, 2) + '\n')
console.log(`明细：${OUT}`)
