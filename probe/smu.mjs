#!/usr/bin/env node
/**
 * jlc-smu — 通过 AOD WMI 的 AM05 发 SMU 邮箱命令。
 *
 * 协议（对应 ryzen_smu / 上游 RyzenSmuController.Send）：
 *   响应码 0x01=成功 0xFD=条件不满足 0xFC=繁忙 0xFE=未知指令
 *
 * AM5（本机 family 19h model 0x61）命令号：
 *   STAPM 限值 0x4F   STAPM 时间 0x53   Fast 0x3E   Slow 0x5F   Slow 时间 0x60
 *
 * 用法：
 *   sudo node probe/smu.mjs --cmd=0x53 --arg=60     # 最安全：只改时间常数
 *   sudo node probe/smu.mjs --cmd=0x4F --arg=45000  # STAPM 45W（会真的限功耗）
 *   sudo node probe/smu.mjs --read=0x4F             # 只读式查询，见下
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : null
}
const CMD = argOf('cmd')
const ARG = argOf('arg')

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'smu.json')
const CALL = '/proc/acpi/call'

const hex = (n, w = 2) => '0x' + n.toString(16).padStart(w, '0')

/** AM05(Arg2)：Arg2 = {cmd:u32, arg:u32} */
function smu(cmd, arg) {
  const b = (v, sh) => hex((v >>> sh) & 0xff)
  const buf = `{${b(cmd, 0)},${b(cmd, 8)},${b(cmd, 16)},${b(cmd, 24)},${b(arg, 0)},${b(arg, 8)},${b(arg, 16)},${b(arg, 24)}}`
  try {
    fs.writeFileSync(CALL, `\\AOD.WMAA 0x0 0x5 ${buf}`)
  } catch (e) {
    return {error: `write: ${e.code || e.message}`}
  }
  const raw = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  if (/error/i.test(raw)) return {error: raw}
  const bytes = [...raw.matchAll(/0x([0-9a-fA-F]{1,2})/g)].map((m) => parseInt(m[1], 16))
  return {raw, bytes}
}

if (process.getuid?.() !== 0) {
  console.error('需要 root')
  process.exit(1)
}
if (!fs.existsSync(CALL)) {
  console.error('/proc/acpi/call 不存在')
  process.exit(1)
}

const report = {schema: 1, at: new Date().toISOString(), cmd: CMD, arg: ARG, result: null}

if (!CMD) {
  console.log('没有 --cmd，只做一次探路：用 0x53 arg=60（STAPM 时间常数）')
}

const cmd = Number(CMD ?? '0x53')
const arg = Number(ARG ?? '60')

console.log(`发送 SMU: cmd=${hex(cmd, 4)} arg=${arg} (${hex(arg, 8)})`)
const r = smu(cmd, arg)
report.result = r

if (r.error) {
  console.log(`失败: ${r.error}`)
} else {
  const b = r.bytes
  console.log(`返回 ${b.length} 字节: ${b.slice(0, 24).map((x) => x.toString(16).padStart(2, '0')).join(' ')}`)
  const rsp = b[0]
  const table = {
    0x01: '成功',
    0xfd: '条件不满足',
    0xfc: '指令被拒绝（繁忙）',
    0xfe: '未知指令',
    0x00: '未响应/忙',
  }
  console.log(`响应码 byte0 = ${hex(rsp)} → ${table[rsp] ?? '需要进一步分析'}`)
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`明细: ${OUT}`)
