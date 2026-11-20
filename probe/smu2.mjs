#!/usr/bin/env node
/**
 * jlc-smu2 — 经 ryzen_smu 内核模块发 SMU 命令（MP1 邮箱）。
 *
 * 接口：
 *   /sys/kernel/ryzen_smu_drv/smu_args   写 6×u32（24 字节小端）
 *   /sys/kernel/ryzen_smu_drv/mp1_smu_cmd 写命令号，读回状态
 *
 * 状态：1=成功 0xFE=未知指令 0xFD=条件不满足 0xFC=繁忙 0xFB=超时
 *
 * 用法：
 *   sudo node probe/smu2.mjs --info                 # 只读：版本/代号/PM 表信息
 *   sudo node probe/smu2.mjs --cmd=0x53 --arg=60    # 最安全：STAPM 时间常数
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
const INFO = argv.includes('--info')

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'smu2.json')
const DIR = '/sys/kernel/ryzen_smu_drv'

const read = (f) => {
  try {
    return fs.readFileSync(path.join(DIR, f), 'utf8').trim()
  } catch (e) {
    return `(${e.code})`
  }
}

const STATUS = {
  0x00: '等待（未完成）',
  0x01: '成功',
  0xfb: '超时',
  0xfc: '被拒绝：繁忙',
  0xfd: '被拒绝：条件不满足',
  0xfe: '未知指令',
  0xff: '失败',
}

const publish = () => {
  const keys = ['version', 'codename', 'mp1_if_version', 'pm_table_version', 'pm_table_size', 'pm_table']
  return Object.fromEntries(keys.map((k) => [k, k === 'pm_table' ? '(二进制，略)' : read(k)]))
}

const report = {schema: 1, at: new Date().toISOString(), info: null, cmd: null, result: null, error: null}

if (!fs.existsSync(DIR)) {
  console.error(`没有 ${DIR}：先 sudo modprobe ryzen_smu`)
  process.exit(1)
}

report.info = publish()
console.log('=== 驱动信息 ===')
for (const [k, v] of Object.entries(report.info)) console.log(`  ${k}: ${v}`)

if (INFO || !CMD) {
  if (!CMD) console.log('\n（未指定 --cmd，只读模式结束）')
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
  process.exit(0)
}

const cmd = Number(CMD)
const arg = Number(ARG ?? '0')

// 6×u32 小端
const args = Buffer.alloc(24)
args.writeUInt32LE(arg >>> 0, 0)

try {
  fs.writeFileSync(path.join(DIR, 'smu_args'), args)
  fs.writeFileSync(path.join(DIR, 'mp1_smu_cmd'), String(cmd))
  const statusRaw = fs.readFileSync(path.join(DIR, 'mp1_smu_cmd'), 'utf8').trim()
  const status = Number(statusRaw)
  report.cmd = {cmd, arg}
  report.result = {statusRaw, status, meaning: STATUS[status] ?? '未知'}

  console.log('\n=== SMU 命令 ===')
  console.log(`  cmd=0x${cmd.toString(16)} arg=${arg}`)
  console.log(`  状态=${statusRaw} (0x${status.toString(16)}) → ${STATUS[status] ?? '未知'}`)
} catch (e) {
  report.error = String(e.message ?? e)
  console.error(`\n失败: ${report.error}`)
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`\n明细: ${OUT}`)
