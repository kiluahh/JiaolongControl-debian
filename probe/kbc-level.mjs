#!/usr/bin/env node
/**
 * jlc-kbc-level — 按 Fn+F6 / Fn+F7 调键盘背光时，EC 里到底哪个字节在动。
 *
 * 背景：键盘背光开/关已确认在 0x078c bit1，但之前写 0x80|level 无法改变明暗，
 * 而 Fn+F6（暗）/ Fn+F7（亮）确实有效 → 亮度状态要么在别的字节，要么根本没进 EC RAM。
 * 这个脚本用「全量 dump 前后对比」把答案找出来。
 *
 * 流程：
 *   dump A
 *   dump A2          → 两次连续 dump 的差异 = 硬件自己刷新的噪声字节
 *   提示按 Fn+F6 两次（键盘变暗）
 *   dump B           → A→B 的变化 = 变暗影响到的东西
 *   提示按 Fn+F7 两次（键盘变亮）
 *   dump C           → B→C 的变化 = 变亮影响到的东西
 *
 * 用法：sudo node probe/kbc-level.mjs
 * 只读，不写任何寄存器。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc-level.json')
const CALL = '/proc/acpi/call'
const LO = 0x0000
const HI = 0x0fff

/** 已知会被硬件自己刷新的地址（温度/转速/占空比/瞬时状态） */
const VOLATILE = [
  [0x043e, 0x043e],
  [0x044f, 0x044f],
  [0x0464, 0x046f],
  [0x04a0, 0x04af],
  [0x0751, 0x0751],
  [0x1804, 0x1809],
]

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const addr = (a) => '0x' + a.toString(16).padStart(4, '0')
const isVolatile = (a) => VOLATILE.some(([x, y]) => a >= x && a <= y)

function read(a) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${a.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  // 只接受单字节：EC 忙时 ECRR 可能返回 64 位垃圾值
  const m = t.match(/^0x([0-9a-fA-F]{1,2})$/)
  return m ? parseInt(m[1], 16) : null
}

function dump(label) {
  const t0 = Date.now()
  process.stdout.write(`dump ${label} … `)
  const out = new Uint8Array(HI - LO + 1)
  for (let a = LO; a <= HI; a++) out[a - LO] = read(a) ?? 0xff
  console.log(`${((Date.now() - t0) / 1000).toFixed(2)}s`)
  return out
}

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/kbc-level.mjs')
  process.exit(1)
}

/** 对比两轮 dump，剔除噪声字节后分类 */
function diff(from, to, noise, name) {
  const stable = []
  const noisy = []
  const volatile = []
  for (let a = LO; a <= HI; a++) {
    if (from[a - LO] === to[a - LO]) continue
    const row = {addr: a, from: from[a - LO], to: to[a - LO]}
    if (noise.has(a)) noisy.push(row)
    else if (isVolatile(a)) volatile.push(row)
    else stable.push(row)
  }
  const fmt = (r) => `${addr(r.addr)}  ${hex(r.from)} → ${hex(r.to)}`
  console.log(`\n── ${name} ──`)
  console.log(`稳定变化（最关键）：${stable.length} 个`)
  for (const r of stable) console.log('  ★ ' + fmt(r))
  if (volatile.length) {
    console.log(`已知易变区内的变化：${volatile.length} 个`)
    for (const r of volatile.slice(0, 20)) console.log('    ' + fmt(r))
  }
  if (noisy.length) {
    console.log(`两次连续 dump 就不一致（噪声，忽略）：${noisy.length} 个`)
    for (const r of noisy.slice(0, 20)) console.log('    ' + fmt(r))
  }
  return {stable, volatile, noisy}
}

console.log(`扫描 EC RAM ${addr(LO)}–${addr(HI)}（每轮 4096 次读取）`)
const A = dump('A（当前状态）')
const A2 = dump('A2（噪声基线）')

const noise = new Set()
for (let a = LO; a <= HI; a++) if (A[a - LO] !== A2[a - LO]) noise.add(a)
console.log(`噪声字节：${noise.size} 个（这些地址本身就在自己变，不能作为证据）`)

const rl = readline.createInterface({input: process.stdin, output: process.stdout})
console.log('\n>>> 现在按两次 Fn+F6（键盘背光变暗），看清变暗后按回车…')
await rl.question('')
const B = dump('B（变暗后）')
console.log('\n>>> 现在按两次 Fn+F7（键盘背光变亮），看清变亮后按回车…')
await rl.question('')
const C = dump('C（变亮后）')
rl.close()

const dim = diff(A, B, noise, 'A → B：按 Fn+F6（变暗）')
const bright = diff(B, C, noise, 'B → C：按 Fn+F7（变亮）')

// 变暗与变亮影响同一批地址 = 强烈指向亮度寄存器
const dimSet = new Set(dim.stable.map((r) => r.addr))
const shared = bright.stable.filter((r) => dimSet.has(r.addr))

console.log('\n════════ 结论 ════════')
if (shared.length) {
  console.log('变暗与变亮改的是同一批字节 → 这就是亮度状态所在：')
  for (const r of shared) console.log(`  ★ ${addr(r.addr)}   （当前 ${hex(r.to)}）`)
} else if (dim.stable.length || bright.stable.length) {
  console.log('有稳定变化，但变暗/变亮改的不是同一批字节，需要单独看上面两段。')
} else {
  console.log('按 Fn+F6 / Fn+F7 没有改变 EC RAM 中任何稳定字节。')
  console.log('→ 亮度状态被 EC 的键盘控制器内部持有，不经由 EC RAM 暴露；')
  console.log('  这种情况下软件无法读写亮度等级，界面只能做开/关。')
}

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      schema: 1,
      at: new Date().toISOString(),
      noise: [...noise].map((a) => addr(a)),
      dim,
      bright,
      shared: shared.map((r) => addr(r.addr)),
      dumpA: [...A].map((v) => v.toString(16).padStart(2, '0')).join(''),
      dumpB: [...B].map((v) => v.toString(16).padStart(2, '0')).join(''),
      dumpC: [...C].map((v) => v.toString(16).padStart(2, '0')).join(''),
    },
    null,
    2,
  ) + '\n',
)
console.log(`\n明细：${OUT}`)
