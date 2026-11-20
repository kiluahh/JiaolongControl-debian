#!/usr/bin/env node
/**
 * jlc-kbc — 键盘颜色 WMI 接口的只读试探。
 *
 * DSDT: \_SB.AMW0.RKBC(arg0, arg1) 走 EC 命令邮箱的"读"方向
 *       \_SB.AMW0.WKBC(d0, d1, cmd0, cmd1) 走"写"方向（本探针不调用）
 *
 * 只发读请求；每个请求失败时固件侧超时约 1 秒。
 *
 * 用法：sudo node probe/kbc.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'kbc.json')
const CALL = '/proc/acpi/call'

const ecRead = (addr) => {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${addr.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  return m ? parseInt(m[1], 16) : null
}

const call = (method, args) => {
  const text = args.map((a) => '0x' + a.toString(16)).join(' ')
  try {
    fs.writeFileSync(CALL, `${method} ${text}`)
  } catch (e) {
    return {error: `write: ${e.code || e.message}`}
  }
  const raw = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  return {raw: raw.slice(0, 200), bytes: [...raw.matchAll(/0x([0-9a-fA-F]{1,2})/g)].map((m) => parseInt(m[1], 16))}
}

if (process.getuid?.() !== 0) {
  console.error('需要 root')
  process.exit(1)
}

const report = {schema: 1, at: new Date().toISOString(), ec: {}, reads: []}

console.log('=== 当前键盘寄存器（直读 EC RAM）===')
for (const [name, addr] of [['mode', 0x767], ['R', 0x769], ['G', 0x76a], ['B', 0x76b], ['BL', 0x78c]]) {
  const v = ecRead(addr)
  report.ec[name] = v
  console.log(`  0x${addr.toString(16)} ${name.padEnd(4)} = ${v === null ? '?' : '0x' + v.toString(16).padStart(2, '0')}`)
}

console.log('\n=== RKBC 只读试探 ===')
for (const [a0, a1] of [[0, 0], [1, 0], [0, 1], [2, 0], [0x10, 0]]) {
  const r = call('\\_SB.AMW0.RKBC', [a0, a1])
  report.reads.push({arg0: a0, arg1: a1, ...r})
  const hex = r.bytes?.slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join(' ') ?? ''
  console.log(`  RKBC(0x${a0.toString(16)}, 0x${a1.toString(16)}) → ${r.error ?? (hex || '(空)')}`)
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`\n明细: ${OUT}`)
