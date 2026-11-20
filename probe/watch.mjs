#!/usr/bin/env node
/**
 * jlc-watch — 盯着 EC 若干字节，把变化实时打印出来。
 * 用途：按热键（如 Fn+Q 切性能模式）时，观察到底哪个寄存器在动。
 *
 * 用法：
 *   sudo node probe/watch.mjs               # 默认 30 秒，12 个候选地址
 *   sudo node probe/watch.mjs --seconds=45
 * 只读，不写任何寄存器。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const SECONDS = Number(arg('seconds', '30'))
const HZ = Number(arg('hz', '5'))

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'watch.json')
const CALL = '/proc/acpi/call'

/** 候选：模式/风扇/键盘/功耗相关 */
const WATCH = [
  0x0726, 0x0727, 0x0740, 0x0741, 0x0743, 0x074e, 0x0751, 0x0765, 0x0766, 0x0767,
  0x078c, 0x078e, 0x1804, 0x1809, 0x043e, 0x044f, 0x0464, 0x0465, 0x046c, 0x046d,
]

function read(addr) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${addr.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  return m ? parseInt(m[1], 16) : null
}

const hex = (v) => (v === null ? '??' : '0x' + v.toString(16).padStart(2, '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.getuid?.() !== 0) {
  console.error('需要 root：sudo node probe/watch.mjs')
  process.exit(1)
}

const t0 = Date.now()
const last = new Map()
const events = []

console.log(`监视 ${WATCH.length} 个地址，${HZ}Hz，共 ${SECONDS}s。请现在开始按热键（例如 Fn+Q）。`)
console.log('地址  ' + WATCH.map((a) => a.toString(16).padStart(4, '0')).join(' '))

// 首轮建立基线
for (const a of WATCH) last.set(a, read(a))

const deadline = t0 + SECONDS * 1000
while (Date.now() < deadline) {
  await sleep(Math.round(1000 / HZ))
  const t = ((Date.now() - t0) / 1000).toFixed(1)
  const changed = []
  for (const a of WATCH) {
    const v = read(a)
    if (v !== last.get(a)) {
      changed.push({t: Number(t), addr: a, from: last.get(a), to: v})
      console.log(`+${t}s  0x${a.toString(16).padStart(4, '0')}  ${hex(last.get(a))} → ${hex(v)}`)
      last.set(a, v)
    }
  }
  events.push(...changed)
}

const final = Object.fromEntries(WATCH.map((a) => ['0x' + a.toString(16), last.get(a)]))
fs.writeFileSync(OUT, JSON.stringify({schema: 1, at: new Date().toISOString(), seconds: SECONDS, events, final}, null, 2) + '\n')

console.log('\n最终值：')
for (const a of WATCH) console.log(`  0x${a.toString(16).padStart(4, '0')}  ${hex(last.get(a))}`)
console.log(`\n共 ${events.length} 次变化，明细：${OUT}`)
