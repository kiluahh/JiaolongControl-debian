#!/usr/bin/env node
/**
 * jlc-mode-set — 按固件语义切换性能档，并验证是否真的生效。
 *
 * 依据 DSDT 的 PMSC/PMSF：
 *   0x0727 bit6 = CUME（自定义，白灯）
 *   0x0751 bit4 = TBME（性能）
 *   0x0751 bit7 = UFME（安静）
 *   两者皆 0 = 平衡
 * 改位后调用 \_SB.PCI0.SBRG.EC0.PMSF() 让固件应用曲线与温度墙。
 *
 * 用法：
 *   sudo node probe/mode-set.mjs --mode=perf
 *   sudo node probe/mode-set.mjs --mode=balance
 *   sudo node probe/mode-set.mjs --mode=quiet
 *   sudo node probe/mode-set.mjs --mode=custom
 *   --keep   不还原（调试用）
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const MODE = arg('mode', 'perf')
const KEEP = argv.includes('--keep')

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'probe', 'mode-set.json')
const CALL = '/proc/acpi/call'

const REG = {
  MODE: 0x0751, // TBME(bit4) / UFME(bit7)
  CUME: 0x0727, // CUME(bit6)
  APTC: 0x0783, // APTC(bit0-6) / APTN(bit7)
  CSMS: 0x072b,
  CPU_TEMP: 0x043e,
  GPU_TEMP: 0x044f,
  CPU_RPM_HI: 0x0464,
  CPU_RPM_LO: 0x0465,
  GPU_RPM_HI: 0x046c,
  GPU_RPM_LO: 0x046d,
}

const BIT = {TBME: 0x10, UFME: 0x80, CUME: 0x40}

/** 目标：各档位的位组合 */
const TARGETS = {
  perf: {modeBit: BIT.TBME, cume: 0},
  balance: {modeBit: 0x00, cume: 0},
  quiet: {modeBit: BIT.UFME, cume: 0},
  custom: {modeBit: 0x00, cume: 1},
}

const log = []
const rec = (s) => {
  log.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`)
  process.stderr.write(s + '\n')
}

function ecRead(addr) {
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRR 0x${addr.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  if (!m) throw new Error(`ECRR 0x${addr.toString(16)} → ${JSON.stringify(t.slice(0, 40))}`)
  return parseInt(m[1], 16)
}

const ecWrite = (addr, v) =>
  fs.writeFileSync(CALL, `\\_SB.INOU.ECRW 0x${addr.toString(16)} 0x${(v & 0xff).toString(16)}`)

function callPmsf() {
  fs.writeFileSync(CALL, '\\_SB.PCI0.SBRG.EC0.PMSF')
  return fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
}

function snap(tag) {
  const s = {
    tag,
    mode: ecRead(REG.MODE),
    cume: ecRead(REG.CUME),
    aptc: ecRead(REG.APTC),
    csms: ecRead(REG.CSMS),
    cpuTemp: ecRead(REG.CPU_TEMP),
    gpuTemp: ecRead(REG.GPU_TEMP),
    cpuRpm: (ecRead(REG.CPU_RPM_HI) << 8) | ecRead(REG.CPU_RPM_LO),
    gpuRpm: (ecRead(REG.GPU_RPM_HI) << 8) | ecRead(REG.GPU_RPM_LO),
  }
  return s
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = {schema: 1, at: new Date().toISOString(), mode: MODE, keep: KEEP, steps: [], error: null, log}

let saved = null
let done = false

function restore() {
  if (!saved || done) return
  done = true
  try {
    ecWrite(REG.MODE, saved.mode)
    ecWrite(REG.CUME, saved.cume)
    callPmsf()
    rec(`已还原 mode=0x${saved.mode.toString(16)} cume=0x${saved.cume.toString(16)}`)
  } catch (e) {
    rec(`还原失败: ${e.message}`)
    rec(`手工: sudo sh -c 'echo "\\\\_SB.INOU.ECRW 0x0751 0x${(saved?.mode ?? 0).toString(16)}" > /proc/acpi/call'`)
    rec(`      sudo sh -c 'echo "\\\\_SB.INOU.ECRW 0x0727 0x${(saved?.cume ?? 0).toString(16)}" > /proc/acpi/call'`)
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

try {
  if (process.getuid?.() !== 0) throw new Error('需要 root')
  if (!fs.existsSync(CALL)) throw new Error('/proc/acpi/call 不存在')

  const t = TARGETS[MODE]
  if (!t) throw new Error(`未知档位 ${MODE}，可选 ${Object.keys(TARGETS).join('/')}`)

  const before = snap('写入前')
  saved = {mode: before.mode, cume: before.cume}
  report.steps.push(before)
  rec(`写入前 mode=0x${before.mode.toString(16)} cume=0x${before.cume.toString(16)} aptc=0x${before.aptc.toString(16)} ${before.cpuTemp}℃ ${before.cpuRpm}RPM`)

  // 只改目标位，保留其余位（0x0751 的 bit5 等由 EC 自己维护）
  const newMode = (before.mode & ~(BIT.TBME | BIT.UFME)) | t.modeBit
  const newCume = (before.cume & ~BIT.CUME) | (t.cume ? BIT.CUME : 0)
  rec(`写入 mode=0x${newMode.toString(16)} cume=0x${newCume.toString(16)}`)
  ecWrite(REG.CUME, newCume)
  ecWrite(REG.MODE, newMode)

  // 回读稳定性：如果 EC 很快改回去，说明这些位不可由软件保持
  for (const d of [0, 300, 1000, 2000]) {
    if (d) await sleep(d - (d === 300 ? 0 : 0))
    const m = ecRead(REG.MODE)
    const c = ecRead(REG.CUME)
    rec(`  +${d}ms 回读 mode=0x${m.toString(16)} cume=0x${c.toString(16)}${m === newMode && c === newCume ? '' : ' ⚠️ 与写入不符'}`)
  }

  const pmsfOut = callPmsf()
  rec(`调用 PMSF → ${JSON.stringify(pmsfOut.slice(0, 60))}`)

  for (let i = 0; i < 6; i++) {
    await sleep(1000)
    const s = snap(`+${i + 1}s`)
    report.steps.push(s)
    rec(`  +${i + 1}s mode=0x${s.mode.toString(16)} aptc=0x${s.aptc.toString(16)} ${s.cpuTemp}/${s.gpuTemp}℃ ${s.cpuRpm}/${s.gpuRpm}RPM`)
  }
} catch (e) {
  report.error = String(e.message ?? e)
  rec(`错误: ${report.error}`)
} finally {
  if (!KEEP) restore()
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(`\n${log.join('\n')}\n明细: ${OUT}\n`)
