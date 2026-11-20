#!/usr/bin/env node
/**
 * jlc-kbc-verify — 键盘背光能力验收（第三版，只用实测有效的字面值）。
 *
 * 前两版错在哪（都是脚本 bug，不是硬件）：
 *   v1: 开灯写「当前值清 bit1」= 0x80，点不亮；实际有效的是字面 0x00。
 *   v2: 固定色用 MODE=0x20，会把灯关掉；实际固定色对应 MODE=0x00。
 *   v1: 回答正则不认 "y"，把成功的关灯判成 FAIL。
 *
 * 现在只用这些**实机验证过的字面值**：
 *   BL  0x02 → 关灯      BT (kbc-power 实测)
 *   BL  0x00 → 开灯      (kbc-power 实测，且回到最暗档)
 *   MODE 0x80 → 呼吸     (kbc-restore / kbc-mode 实测)
 *   MODE 0x00 → 固定色   (kbc-restore 第 3 步实测)
 *   RGB 0x0769/6a/6b → 通道值
 *
 * 用法：sudo node probe/kbc-verify.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-verify.json')
const CALL = '/proc/acpi/call'

const REG = {MODE: 0x0767, R: 0x0769, G: 0x076a, B: 0x076b, BL: 0x078c}
/** 只用实测过的字面值，不做位运算推导 */
const LITERAL = {OFF: 0x02, ON: 0x00, BREATH: 0x80, STATIC: 0x00}

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/) // EC 忙时会返回 64 位垃圾，拒收
  return m ? parseInt(m[1], 16) : null
}
const write = (a, v) => fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)

const isOff = (bl) => bl !== null && (bl & 0x02) !== 0
const rawLevel = (bl) => (bl >> 5) & 0x07
const uiLevel = (bl) => (isOff(bl) ? 0 : rawLevel(bl) + 1)
const isYes = (s) => /^(y|yes|是|对|有|亮|灭|关|红|绿|蓝|呼吸|循环|嗯|ok|okay)/i.test(String(s).trim())

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-verify.mjs')
  process.exit(1)
}

const results = []
const rl = readline.createInterface({input: process.stdin, output: process.stdout})
let restored = false

/** 同步恢复：亮灯用 0x00，呼吸用 0x80，RGB 全白 */
function restore() {
  if (restored) return
  restored = true
  write(REG.MODE, LITERAL.BREATH)
  write(REG.R, 0xff)
  write(REG.G, 0xff)
  write(REG.B, 0xff)
  write(REG.BL, LITERAL.ON)
  console.log(`\n已恢复：MODE=${hex(read(REG.MODE))} RGB=${[read(REG.R), read(REG.G), read(REG.B)].map(hex).join(',')} BL=${hex(read(REG.BL))}`)
  console.log('（呼吸灯效 + 开灯，亮度可能是最低档，按 Fn+F7 调回去）')
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130) })

async function ask(q) {
  return (await rl.question(`   ${q} `)).trim()
}

/** 灯灭就用 0x00 点亮；不行再提示按 Fn 键 */
async function ensureLit(where) {
  for (let i = 0; i < 2; i++) {
    write(REG.BL, LITERAL.ON)
    await sleep(300)
    const bl = read(REG.BL)
    const ok = /^(y|yes|是|对|亮|有|嗯|ok)/i.test(await ask(`[点亮] 写 BL=0x00 → 回读 ${hex(bl)}。${where} 现在亮着吗？(y/n)`))
    if (ok) {
      results.push({name: '确保亮灯', answer: 'BL=0x00 有效', pass: true})
      return true
    }
    console.log('   请手动按 2~3 次 Fn+F7 再回答。')
  }
  results.push({name: '确保亮灯', answer: '0x00 + Fn 键都失败', pass: false})
  console.log('   ✘ 灯点不亮，冷启动可让 EC 重新初始化。\n')
  return false
}

async function test(name, action, question) {
  console.log(`── ${name}`)
  await ask('按回车执行…')
  action()
  await sleep(350)
  const bl = read(REG.BL)
  const mode = read(REG.MODE)
  const rgb = [read(REG.R), read(REG.G), read(REG.B)]
  console.log(`   回读：BL=${hex(bl)} MODE=${hex(mode)} RGB=${rgb.map(hex).join(',')}`)
  const answer = await ask(question)
  const pass = isYes(answer)
  results.push({name, answer, pass, bl, mode, rgb})
  console.log(`   ${pass ? '✔ PASS' : '✘ FAIL'}\n`)
  return pass
}

console.log('════ 键盘背光能力验收（只用实测字面值）════\n')

// 0. 确保亮灯
console.log(`当前：BL=${hex(read(REG.BL))} MODE=${hex(read(REG.MODE))} RGB=${[read(REG.R), read(REG.G), read(REG.B)].map(hex).join(',')}`)
await ensureLit('（起始）')
console.log('')

// 1. 呼吸
await test('呼吸灯效：MODE = 0x80', () => write(REG.MODE, LITERAL.BREATH), '现在是呼吸/循环效果吗？(y/n)')

// 2~4. 固定色：MODE = 0x00（不是 0x20）
for (const [name, rgb, word] of [
  ['固定红色', [0xff, 0x00, 0x00], '红'],
  ['固定绿色', [0x00, 0xff, 0x00], '绿'],
  ['固定蓝色', [0x00, 0x00, 0xff], '蓝'],
]) {
  await test(
    `${name}：RGB + MODE=0x00`,
    () => {
      write(REG.R, rgb[0])
      write(REG.G, rgb[1])
      write(REG.B, rgb[2])
      write(REG.MODE, LITERAL.STATIC)
    },
    `现在是${word}色、并且还亮着吗？(y/n)`,
  )
}

// 5. 亮度档位读取
console.log('── 亮度档位读取：0x078c bits[7:5]（只读镜像）')
console.log('   20 秒内请按：Fn+F6 两次，再 Fn+F7 两次。')
await ask('准备好后按回车开始…')
{
  const t0 = Date.now()
  let last = read(REG.BL)
  console.log(`   起始：档位 ${uiLevel(last)} (BL=${hex(last)})`)
  const seen = new Set([rawLevel(last)])
  while (Date.now() - t0 < 20000) {
    await sleep(50)
    const v = read(REG.BL)
    if (v === null) continue
    if (v !== last && (v & 0xe0) !== (last & 0xe0)) {
      console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s  档位 ${uiLevel(last)} → ${uiLevel(v)}`)
      seen.add(rawLevel(v))
    }
    last = v
  }
  const ok = seen.size >= 2
  console.log(`   观察到 ${seen.size} 个档位：${[...seen].sort().join(', ')}  ${ok ? '✔ PASS' : '✘ FAIL'}\n`)
  results.push({name: '亮度档位读取', answer: [...seen].sort().join(','), pass: ok})
}

// 6. 开关（字面值，最后做）
const offOk = await test('关灯：BL = 0x02', () => write(REG.BL, LITERAL.OFF), '灯灭了吗？(y/n)')
if (offOk) {
  const onOk = await test('开灯：BL = 0x00', () => write(REG.BL, LITERAL.ON), '灯又亮了吗？(y/n)')
  if (!onOk) console.log('   ⚠ 0x02 关掉后 0x00 点不回来 → 开关不可用，界面不应提供关灯。\n')
}

rl.close()
restore()

console.log('════ 结果 ════')
for (const r of results) console.log(`  ${r.pass ? '✔' : '✘'} ${r.name.padEnd(20)} ${r.answer || '（未答）'}`)
console.log(`\n通过 ${results.filter((r) => r.pass).length}/${results.length}`)

fs.writeFileSync(OUT, JSON.stringify({schema: 3, at: new Date().toISOString(), literal: LITERAL, results}, null, 2) + '\n')
console.log(`明细：${OUT}`)
