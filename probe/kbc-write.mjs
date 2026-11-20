#!/usr/bin/env node
/**
 * jlc-kbc-write — 验证「写 EC 真的能改键盘背光亮度」。
 *
 * 为什么需要这一步：Fn+F6/F7 会让 0x078c 变化，但这只证明「按键时这个字节被改了」，
 * 不证明「写这个字节能驱动背光」。两者必须分开验证，否则又会出现
 * 「寄存器回读成功 = 功能可用」这种假阳性。
 *
 * 流程：读原值 → 逐个写入候选值 → 每次停下等你看清 → 结尾恢复原值。
 *
 * 用法：
 *   sudo node probe/kbc-write.mjs                          # 默认测 0x00 0x40 0x80 0xc0
 *   sudo node probe/kbc-write.mjs --values=0x00,0x40,0x80   # 指定候选
 *   sudo node probe/kbc-write.mjs --addr=0x078c --hold=2000 # 非交互，每档 2 秒
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-write.json')
const CALL = '/proc/acpi/call'
const REG = Number(arg('addr', '0x078c'))
const HOLD = arg('hold', null)
const VALUES = arg('values', '0x00,0x40,0x80,0xc0')
  .split(',')
  .map((s) => parseInt(s.trim().replace(/^0x/i, ''), 16) & 0xff)

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  // 只接受单字节：EC 忙时 ECRR 可能返回 64 位垃圾值
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}

function write(a, v) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)
}

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-write.mjs')
  process.exit(1)
}

const original = read(REG)
if (original === null) {
  console.error(`读不到 ${hex(REG)}，先确认 acpi_call 已加载`)
  process.exit(1)
}

let restored = false
const restore = () => {
  if (restored) return
  restored = true
  write(REG, original)
  const back = read(REG)
  console.log(`\n已恢复 0x${REG.toString(16)} = ${hex(original)}（回读 ${hex(back)}）`)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130) })

console.log(`寄存器 0x${REG.toString(16)}，原值 ${hex(original)}`)
console.log(`候选值：${VALUES.map(hex).join(' ')}\n`)
console.log('每次写入后会停下，你看键盘背光：变亮了 / 变暗了 / 没反应。\n')

const rl = HOLD ? null : readline.createInterface({input: process.stdin, output: process.stdout})
const results = []

// 先回到原值做基准
write(REG, original)
if (rl) await rl.question(`基准：${hex(original)}，这就是平时最亮/最暗的样子。按回车开始逐个测试…`)
else await sleep(Number(HOLD))

for (const v of VALUES) {
  write(REG, v)
  const back = read(REG)
  const kept = back === v
  console.log(`写入 ${hex(v)} → 回读 ${hex(back)}${kept ? '（保持）' : '（被 EC 改写）'}`)
  let note = ''
  if (rl) {
    note = await rl.question('   实际看到了什么？(直接回车=记下"待确认") ')
  } else {
    await sleep(Number(HOLD))
  }
  results.push({value: v, readback: back, accepted: kept, observed: note.trim()})
  console.log('')
}
if (rl) rl.close()

restore()

console.log('\n──── 结果 ────')
for (const r of results) {
  console.log(`  ${hex(r.value)}  ${r.accepted ? '写入保持' : '被改写'}  ${r.observed || '（未记录）'}`)
}
console.log('\n判定标准：只有当「写入保持」且「你看到亮度真的变了」同时成立，才算这个字节控制亮度。')

fs.writeFileSync(
  OUT,
  JSON.stringify({schema: 1, at: new Date().toISOString(), reg: '0x' + REG.toString(16), original, results}, null, 2) + '\n',
)
console.log(`\n明细：${OUT}`)
