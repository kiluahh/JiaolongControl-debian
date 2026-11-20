#!/usr/bin/env node
/**
 * jlc-aod — 验证 AMD AOD（WMI→SMU 邮箱）通道是否可用。
 *
 * 只调只读功能：AM01(值) / AM03 / AM04(idx) / AM07(idx) / AM09。
 * 不调用 AM05（写 SMU 命令），除非显式 --cmd=<hex>[,<arg>]。
 *
 * 用法：
 *   sudo node probe/aod.mjs
 *   sudo node probe/aod.mjs --cmd=0x02,0x0      # 谨慎：会真的发一条 SMU 命令
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : null
}
const CMD = argOf('cmd')

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'aod.json')
const CALL = '/proc/acpi/call'
const WMAA = '\\AOD.WMAA'

const hex = (n) => '0x' + n.toString(16)

function call(args) {
  const text = args
    .map((a) => (typeof a === 'number' ? hex(a) : a))
    .join(' ')
  try {
    fs.writeFileSync(CALL, `${WMAA} ${text}`)
  } catch (e) {
    return {error: `write: ${e.code || e.message}`}
  }
  const raw = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  if (/error/i.test(raw)) return {error: raw}
  const bytes = [...raw.matchAll(/0x([0-9a-fA-F]{1,2})/g)].map((m) => parseInt(m[1], 16))
  const nums = raw.match(/^\d+$/) ? Number(raw) : null
  return {raw: raw.slice(0, 200), bytes, num: nums, len: bytes.length}
}

function bufOf(...words) {
  return '{' + words.flatMap((w) => [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >>> 24) & 0xff].map((b) => hex(b))).join(',') + '}'
}

const dump = (bytes, n = 32) =>
  bytes.slice(0, n).map((b) => b.toString(16).padStart(2, '0')).join(' ')

const report = {schema: 1, at: new Date().toISOString(), results: {}, error: null}

try {
  if (process.getuid?.() !== 0) throw new Error('需要 root：sudo node probe/aod.mjs')
  if (!fs.existsSync(CALL)) throw new Error('/proc/acpi/call 不存在')

  // AM01：返回 AODV（AOD 版本/状态值）
  report.results.am01 = call([0, 1])
  // AM03：返回 OBID（对象表）
  report.results.am03 = call([0, 3])
  // AM09：RMPD（运行模式/平台数据，0x8C 字节）
  report.results.am09 = call([0, 9])
  // AM07(idx)：DSPD 分段（0x214 字节），取前 3 段
  report.results.am07 = {}
  for (let i = 0; i <= 2; i++) report.results.am07['idx' + i] = call([0, 7, bufOf(i)])
  // AM04(idx)：按 OBIT 表查一项（0x19C 字节）
  report.results.am04 = {}
  for (const i of [1, 2, 3]) report.results.am04['idx' + i] = call([0, 4, bufOf(i)])

  if (CMD) {
    const [cmd, arg] = CMD.split(',').map((s) => Number(s.trim()))
    report.results.smuCommand = {cmd, arg: arg || 0, ...call([0, 5, bufOf(cmd, arg || 0)])}
  }

  console.log('=== AM01 ===')
  console.log(report.results.am01.error ?? `num=${report.results.am01.num} raw=${report.results.am01.raw}`)
  for (const key of ['am03', 'am09']) {
    const r = report.results[key]
    console.log(`\n=== ${key} ===`)
    console.log(r.error ?? `len=${r.len}  ${dump(r.bytes)}`)
  }
  for (const [k, r] of Object.entries(report.results.am07)) {
    console.log(`\n=== AM07 ${k} ===`)
    console.log(r.error ?? `len=${r.len}  ${dump(r.bytes)}`)
  }
  for (const [k, r] of Object.entries(report.results.am04)) {
    console.log(`\n=== AM04 ${k} ===`)
    console.log(r.error ?? `len=${r.len}  ${dump(r.bytes)}`)
  }
  if (report.results.smuCommand) {
    const r = report.results.smuCommand
    console.log(`\n=== SMU cmd ${hex(r.cmd)} arg ${hex(r.arg)} ===`)
    console.log(r.error ?? `len=${r.len}  ${dump(r.bytes, 48)}`)
  }
} catch (e) {
  report.error = String(e.message ?? e)
  console.error(`错误: ${report.error}`)
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`\n明细: ${OUT}`)
