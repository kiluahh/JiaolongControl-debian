#!/usr/bin/env node
/**
 * jlc-kbc-apply — 按 TUXEDO 官方 GPL 驱动的写法验证键盘背光，补上 apply 位。
 *
 * 参考实现（tuxedo-drivers/src/uniwill_leds.h）：
 *   档位： 0x078c = (cur & 0x0f) | (level << 5) | 0x10      ← 0x10 是 apply 位
 *   唤醒： 灯关着时 0x078c 的写入不会生效，需先让 0x1808 != 0
 *   颜色： 0x0769/6a/6b = value * 200 / (255 * 4)  → 0..50，然后 0x0767 |= 0x20
 *   档位 0..4（0 = 关灯），RGB 全零是 EC 的特殊值，应改用 level 0
 *
 * 之前所有失败都源于漏了 0x10 这个 apply 位。
 *
 * 用法：sudo node probe/kbc-apply.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-apply.json')
const CALL = '/proc/acpi/call'

const REG = {MODE: 0x0767, R: 0x0769, G: 0x076a, B: 0x076b, BL: 0x078c, BLUE_IMM: 0x1808}
const APPLY = 0x10 // 0x078c bit4 = SUBCMD_RESET
const APPLY_COLOR = 0x20 // 0x0767 bit5

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isYes = (s) => /^(y|yes|是|对|有|亮|灭|红|绿|蓝|嗯|ok)/i.test(String(s).trim())

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}
const write = (a, v) => fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)

/** 照抄驱动：保留低 4 位，写入档位并置 apply 位 */
function setLevel(level) {
  const cur = read(REG.BL) ?? 0
  const data = (cur & 0x0f) | ((level & 0x07) << 5) | APPLY
  write(REG.BL, data)
  return data
}

/** 唤醒：灯关着时 0x078c 写入不生效，先把 0x1808 抬起来 */
function wake() {
  const imm = read(REG.BLUE_IMM)
  if (imm === 0) {
    write(REG.BLUE_IMM, 0x01)
    return '写了 0x1808=0x01 唤醒'
  }
  return `0x1808 已是 ${hex(imm)}，无需唤醒`
}

const rgbToEc = (v) => Math.round((v * 200) / (255 * 4)) // 0..50

/** 照抄驱动：写三通道（0..50），再置 APPLY_COLOR */
function setColor(r, g, b) {
  const ec = [rgbToEc(r), rgbToEc(g), rgbToEc(b)]
  write(REG.R, ec[0])
  write(REG.G, ec[1])
  write(REG.B, ec[2])
  const mode = read(REG.MODE) ?? 0
  write(REG.MODE, mode | APPLY_COLOR)
  return ec
}

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-apply.mjs')
  process.exit(1)
}

const saved = {bl: read(REG.BL), mode: read(REG.MODE), rgb: [read(REG.R), read(REG.G), read(REG.B)]}
let restored = false
function restore() {
  if (restored) return
  restored = true
  wake()
  setLevel(4) // 留在最亮，避免把灯留在熄灭状态
  write(REG.R, saved.rgb[0])
  write(REG.G, saved.rgb[1])
  write(REG.B, saved.rgb[2])
  write(REG.MODE, (saved.mode & ~APPLY_COLOR) | 0) // 交还呼吸，不保留 apply
  console.log(`\n已恢复：档位 4，RGB=${[read(REG.R), read(REG.G), read(REG.B)].map(hex).join(',')} MODE=${hex(read(REG.MODE))}`)
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
  console.log(`   ${info ? info + '  ' : ''}回读 0x078c=${hex(read(REG.BL))} MODE=${hex(read(REG.MODE))} RGB=${[read(REG.R), read(REG.G), read(REG.B)].map(hex).join(',')}`)
  const answer = await ask(question)
  const pass = isYes(answer)
  results.push({name, answer, pass})
  console.log(`   ${pass ? '✔ PASS' : '✘ FAIL'}\n`)
  return pass
}

console.log('════ 带 apply 位的键盘验证 ════')
console.log(`初始：0x078c=${hex(saved.bl)} MODE=${hex(saved.mode)} RGB=${saved.rgb.map(hex).join(',')}`)
console.log(`档位解码历史：0x00/0x20/0x40/0x60/0x80，0 = 关灯\n`)

// 1. 唤醒 + 拉满
await step(
  '档位 4（最亮）：0x078c = 0x80 | 0x10',
  () => {
    const w = wake()
    setLevel(4)
    return w
  },
  '现在是最亮吗？(y/n)',
)

// 2. 中间档
await step('档位 2：0x078c = 0x40 | 0x10', () => setLevel(2), '亮度明显降下来了？(y/n)')

// 3. 最暗一档
await step('档位 1：0x078c = 0x20 | 0x10', () => setLevel(1), '变成最暗一档了？(y/n)')

// 4. 关灯
const offOk = await step('档位 0（关灯）：0x078c = 0x10', () => setLevel(0), '灯灭了吗？(y/n)')

// 5. 关灯后再点亮（这是之前彻底失败的那一步）
if (offOk) {
  await step(
    '从熄灭状态重新点亮：唤醒 + 档位 4',
    () => {
      const w = wake()
      setLevel(4)
      return w
    },
    '灯又亮回来了吗？(y/n)',
  )
}

// 6. 颜色
await step(
  '颜色：0x0769=50(红) 0x076a=0 0x076b=0，然后 0x0767 |= 0x20',
  () => {
    const ec = setColor(255, 0, 0)
    return `写入通道 ${ec.join(',')}`
  },
  '现在是红色吗？(y/n)',
)

rl.close()
restore()

console.log('════ 结果 ════')
for (const r of results) console.log(`  ${r.pass ? '✔' : '✘'} ${r.name.padEnd(46)} ${r.answer || '（未答）'}`)
console.log(`\n通过 ${results.filter((r) => r.pass).length}/${results.length}`)
fs.writeFileSync(OUT, JSON.stringify({schema: 1, at: new Date().toISOString(), saved, results}, null, 2) + '\n')
console.log(`明细：${OUT}`)
