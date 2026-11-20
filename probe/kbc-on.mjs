#!/usr/bin/env node
/**
 * jlc-kbc-on — 把被软件关掉的键盘背光重新点亮。
 *
 * 背景：验收脚本里写 0x078c=0x82 关灯成功，但随后写 0x80 没能点回来。
 * 而更早的 kbc-power 测试里 0x00 能把灯点回来。说明「开灯」对写入值敏感，
 * 不是简单清 bit1 就行。这个脚本按「最可能有效 → 兜底」逐个试，成功即停。
 *
 * 顺便它也是设计依据：如果只有某些值能点亮，app 的开关就必须用那个值。
 *
 * 用法：sudo node probe/kbc-on.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-on.json')
const CALL = '/proc/acpi/call'
const BL = 0x078c
const MODE = 0x0767

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}
const write = (a, v) => fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${a.toString(16)} 0x${(v & 0xff).toString(16)}`)

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-on.mjs')
  process.exit(1)
}

const isYes = (s) => /^(y|yes|是|对|亮|有|嗯|ok)/i.test(s.trim())

const cur = read(BL)
console.log(`当前 0x078c = ${hex(cur)}   0x0767 = ${hex(read(MODE))}`)
console.log(`电源位(bit1)=${cur & 0x02 ? '1（EC 认为已关灯）' : '0（EC 认为已开灯）'}`)
console.log('如果灯是灭的，跟着提示逐条试即可。\n')

const rl = readline.createInterface({input: process.stdin, output: process.stdout})
const tried = []

/** 依次尝试：先单纯清 bit1，再归零，再强制关→开一次 */
const STEPS = [
  {why: '清 bit1，保留其它位（0x80）', run: () => write(BL, read(BL) & ~0x02)},
  {why: '整字节写 0x00（kbc-power 里成功点亮过的值）', run: () => write(BL, 0x00)},
  {why: '强制关→开：先 0x02 再 0x00', run: () => { write(BL, 0x02); write(BL, 0x00) }},
  {why: '写 0x01（最低位试探）', run: () => write(BL, 0x01)},
]

for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i]
  console.log(`── 第 ${i + 1}/${STEPS.length} 步：${s.why}`)
  await rl.question('   按回车执行…')
  s.run()
  await sleep(400)
  const back = read(BL)
  console.log(`   回读 0x078c = ${hex(back)}`)
  const obs = (await rl.question('   灯亮了吗？(y/n) ')).trim()
  tried.push({step: i + 1, why: s.why, readback: back, lit: isYes(obs), answer: obs})
  if (isYes(obs)) {
    console.log('\n→ 灯已点亮，停止。')
    break
  }
  console.log('')
}

if (!tried.some((t) => t.lit)) {
  console.log('\n⚠ 四步都没点亮。请手动按 2~3 次 Fn+F7（或 Fn+F6），EC 的按键处理会自己重新点亮。')
  console.log('  仍然不亮就冷启动一次（关机再开机），EC 会重新初始化。')
}
rl.close()

fs.writeFileSync(OUT, JSON.stringify({schema: 1, at: new Date().toISOString(), initial: cur, tried}, null, 2) + '\n')
console.log(`\n明细：${OUT}`)
