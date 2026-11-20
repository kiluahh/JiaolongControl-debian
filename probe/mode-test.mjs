#!/usr/bin/env node
/**
 * jlc-mode-test — 三档性能模式验证（可回滚）
 *
 * 对 0x0751 依次写入 性能(0x00) / 安静(0x10)，每次采样温度与转速，
 * 最后写回原值。用来确认三个档位在本机是否真的改变 EC 行为。
 *
 * 用法：
 *   sudo node probe/mode-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_JSON = path.join(ROOT, 'probe', 'mode-test.json')
const OUT_TXT = path.join(ROOT, 'probe', 'mode-test.txt')
const CALL = '/proc/acpi/call'

const REG = {
  MODE: 0x0751,
  CPU_TEMP: 0x043e,
  GPU_TEMP: 0x044f,
  CPU_RPM_HI: 0x0464,
  CPU_RPM_LO: 0x0465,
  GPU_RPM_HI: 0x046c,
  GPU_RPM_LO: 0x046d,
  PL1: 0x006a,
  PL2: 0x006b,
}

const MODES = [
  {name: '性能', value: 0x00},
  {name: '安静', value: 0x10},
]

let saved = null
let restored = false

const log = []
const rec = (s) => {
  log.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`)
  process.stderr.write(s + '\n')
}

function ecRead(addr) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${addr.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  if (!m) throw new Error(`ECRR 0x${addr.toString(16)} 返回 ${JSON.stringify(t.slice(0, 40))}`)
  return parseInt(m[1], 16)
}

const ecWrite = (addr, val) =>
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${addr.toString(16)} 0x${(val & 0xff).toString(16)}`)

function snap() {
  return {
    at: new Date().toISOString(),
    mode: ecRead(REG.MODE),
    cpuTemp: ecRead(REG.CPU_TEMP),
    gpuTemp: ecRead(REG.GPU_TEMP),
    cpuRpm: (ecRead(REG.CPU_RPM_HI) << 8) | ecRead(REG.CPU_RPM_LO),
    gpuRpm: (ecRead(REG.GPU_RPM_HI) << 8) | ecRead(REG.GPU_RPM_LO),
    pl1: ecRead(REG.PL1),
    pl2: ecRead(REG.PL2),
  }
}

function restore() {
  if (!saved || restored) return
  restored = true
  try {
    ecWrite(REG.MODE, saved.mode)
    rec(`已回滚 0x0751 = 0x${saved.mode.toString(16)}`)
  } catch (e) {
    rec(`❌ 回滚失败: ${e.message}`)
    rec(`手工恢复: sudo sh -c 'echo "\\\\_SB.INOU.ECRW 0x0751 0x${saved.mode.toString(16)}" > /proc/acpi/call'`)
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function sample(label, seconds) {
  const out = []
  for (let i = 0; i < seconds; i++) {
    await sleep(1000)
    const s = snap()
    out.push(s)
    rec(`  ${label} +${i + 1}s mode=0x${s.mode.toString(16)} ${s.cpuTemp}/${s.gpuTemp}℃ ${s.cpuRpm}/${s.gpuRpm}RPM`)
  }
  return out
}

const report = {schema: 1, tool: 'jlc-mode-test', at: new Date().toISOString(), phases: {}, error: null, log}

try {
  if (process.getuid?.() !== 0) throw new Error('需要 root：sudo node probe/mode-test.mjs')
  if (!fs.existsSync(CALL)) throw new Error('/proc/acpi/call 不存在，先 modprobe acpi_call')

  const base = snap()
  saved = base
  report.phases.baseline = {mode: base.mode, samples: [base]}
  rec(`原值 0x0751=0x${base.mode.toString(16)}，PL1=${base.pl1} PL2=${base.pl2}，${base.cpuTemp}℃ ${base.cpuRpm}RPM`)

  for (const m of MODES) {
    rec(`切到「${m.name}」0x${m.value.toString(16)}`)
    ecWrite(REG.MODE, m.value)
    const read = ecRead(REG.MODE)
    rec(`  回读 0x0751 = 0x${read.toString(16)}${read === m.value ? '' : ' ⚠️ 与写入值不同（EC 可能拒绝了该档位）'}`)
    report.phases[m.name] = {written: m.value, readBack: read, samples: await sample(m.name, 5)}
  }
} catch (e) {
  report.error = String(e.message ?? e)
  rec(`错误: ${report.error}`)
} finally {
  restore()
  await sleep(1000)
  try {
    report.phases.restored = {samples: await sample('回滚后', 3)}
  } catch {}
}

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n')
fs.writeFileSync(OUT_TXT, log.join('\n') + '\n')

const fmt = (ph) => {
  if (!ph?.samples?.length) return '—'
  const s = ph.samples.at(-1)
  return `${s.cpuTemp}℃ ${s.cpuRpm}RPM`
}
const lines = [
  '性能模式测试',
  `原值: mode=0x${(saved?.mode ?? 0).toString(16)} ${fmt(report.phases.baseline)}`,
  ...MODES.map((m) => `${m.name}(0x${m.value.toString(16)}): 回读 0x${(report.phases[m.name]?.readBack ?? 0).toString(16)} ${fmt(report.phases[m.name])}`),
  `回滚后: ${fmt(report.phases.restored)}`,
  report.error ? `错误: ${report.error}` : '',
  `日志: ${OUT_JSON}`,
].filter(Boolean)

process.stdout.write('\n' + lines.join('\n') + '\n')
