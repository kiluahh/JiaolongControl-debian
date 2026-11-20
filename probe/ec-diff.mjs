#!/usr/bin/env node
/**
 * jlc-ec-diff — 全量 EC RAM 前后对比，用来定位"按键改变了哪个字节"。
 *
 * 流程：
 *   A  → 立刻再 dump 一次 A2（用来识别噪声字节）
 *   → 提示你按一次性能模式键（LED 会变色）
 *   → dump B
 *   → 输出「A→B 变了、但 A→A2 没变」的地址，那就是真正的状态字节。
 *
 * 用法：sudo node probe/ec-diff.mjs
 * 只读。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'ec-diff.json')
const CALL = '/proc/acpi/call'
const LO = 0x0000
const HI = 0x0fff

/** 已知会被硬件自己刷新的地址（温度/转速/占空比/瞬时状态） */
const VOLATILE = [
  [0x043e, 0x043e], [0x044f, 0x044f],
  [0x0464, 0x046f], [0x04a0, 0x04af],
  [0x0751, 0x0751], [0x1804, 0x1809],
]

const hex = (v) => '0x' + v.toString(16).padStart(2, '0')
const isVolatile = (a) => VOLATILE.some(([x, y]) => a >= x && a <= y)

function read(addr) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${addr.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  return m ? parseInt(m[1], 16) : null
}

function dump() {
  const out = new Uint8Array(HI - LO + 1)
  for (let a = LO; a <= HI; a++) out[a - LO] = read(a) ?? 0xff
  return out
}

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/ec-diff.mjs')
  process.exit(1)
}

console.log(`正在 dump EC RAM 0x${LO.toString(16)}-0x${HI.toString(16)}（约 4096 次读取）…`)
const t0 = Date.now()
const A = dump()
const A2 = dump()
console.log(`两轮 dump 用了 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const rl = readline.createInterface({input: process.stdin, output: process.stdout})
await rl.question('\n现在按一次「性能模式」键，看到 LED 变色后按回车继续…')
rl.close()

const B = dump()

const noise = new Set()
const changed = []
for (let a = LO; a <= HI; a++) {
  const same12 = A[a - LO] === A2[a - LO]
  if (!same12) noise.add(a)
  if (A[a - LO] !== B[a - LO]) changed.push({addr: a, a: A[a - LO], b: B[a - LO], noisy: !same12})
}

const stable = changed.filter((c) => !c.noisy && !isVolatile(c.addr))
const stableVolatile = changed.filter((c) => !c.noisy && isVolatile(c.addr))

const fmt = (c) => `0x${c.addr.toString(16).padStart(4, '0')}  ${hex(c.a)} → ${hex(c.b)}`

console.log(`\n噪声字节（两次连续 dump 就不一致）：${noise.size} 个`)
console.log(`\n按前/按后发生变化且稳定：${stable.length} 个`)
for (const c of stable) console.log('  ★ ' + fmt(c))
if (stableVolatile.length) {
  console.log(`\n发生变化但属已知易变区：${stableVolatile.length} 个`)
  for (const c of stableVolatile.slice(0, 20)) console.log('    ' + fmt(c))
}

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      schema: 1,
      at: new Date().toISOString(),
      noise: [...noise].map((a) => '0x' + a.toString(16)),
      changed: changed.map((c) => ({addr: '0x' + c.addr.toString(16), from: hex(c.a), to: hex(c.b), noisy: c.noisy})),
      stable: stable.map((c) => ({addr: '0x' + c.addr.toString(16), from: hex(c.a), to: hex(c.b)})),
      dumpA: [...A].map((v) => v.toString(16).padStart(2, '0')).join(''),
      dumpB: [...B].map((v) => v.toString(16).padStart(2, '0')).join(''),
    },
    null,
    2,
  ) + '\n',
)
console.log(`\n明细：${OUT}`)
