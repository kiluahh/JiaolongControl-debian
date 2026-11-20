#!/usr/bin/env node
/**
 * jlc-ec — 通过 ACPI `\_SB.INOU.ECRR` 读取本机（Uniwill/Tongfang 平台）EC RAM
 *
 * 用法：
 *   sudo node probe/ec.mjs              # 关键地址 + 三个窗口
 *   sudo node probe/ec.mjs --full       # 0x0000-0x0FFF 全量（约 4096 次调用）
 *   node probe/ec.mjs --dry-run         # 不提权，只验证解析与已知地址表
 *
 * 纪律：只调用 ECRR（读），绝不调用 ECRW（写）。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const DRY = flag('dry-run')
const FULL = flag('full')
const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_JSON = path.join(ROOT, 'probe', 'ec-report.json')
const OUT_TXT = path.join(ROOT, 'probe', 'ec-report.txt')
const CALL = '/proc/acpi/call'
const METHOD = '\\_SB.INOU.ECRR'

/** 同平台已验证地址（mechrevo-drivers / TUXEDO uniwill 定义）+ 本机 DSDT 的 PL1..PL4 */
const KNOWN = [
  {addr: 0x043e, name: 'CPU_TEMP', kind: 'temp', note: 'CPU EC 温度 (°C)'},
  {addr: 0x044f, name: 'GPU_TEMP', kind: 'temp', note: 'GPU EC 温度 (°C)'},
  {addr: 0x0464, name: 'CPU_RPM_HI', kind: 'rpmhi', note: 'CPU 风扇转速高字节'},
  {addr: 0x0465, name: 'CPU_RPM_LO', kind: 'rpmlo', note: 'CPU 风扇转速低字节'},
  {addr: 0x046c, name: 'GPU_RPM_HI', kind: 'rpmhi', note: 'GPU 风扇转速高字节'},
  {addr: 0x046d, name: 'GPU_RPM_LO', kind: 'rpmlo', note: 'GPU 风扇转速低字节'},
  {addr: 0x0740, name: 'BAREBONE_ID', kind: 'id', note: '机种 ID（蛟龙16K 期望 0x10）'},
  {addr: 0x0727, name: 'CUSTOM_PROFILE', kind: 'mode', note: '自定义性能档'},
  {addr: 0x074e, name: 'FN_LOCK', kind: 'flag', note: 'Fn 锁'},
  {addr: 0x0767, name: 'RGB_MODE', kind: 'mode', note: '键盘灯模式 (bit0x20=应用颜色, 0x80=彩虹)'},
  {addr: 0x0769, name: 'RGB_R', kind: 'byte', note: '键盘红'},
  {addr: 0x076a, name: 'RGB_G', kind: 'byte', note: '键盘绿'},
  {addr: 0x076b, name: 'RGB_B', kind: 'byte', note: '键盘蓝'},
  {addr: 0x078c, name: 'KBD_BL_STATUS', kind: 'mode', note: '键盘背光状态'},
  {addr: 0x078e, name: 'FAN_CTRL_STATUS', kind: 'mode', note: '风扇控制能力位 (0x40=支持)'},
  {addr: 0x006a, name: 'PL1', kind: 'power', note: '长时功耗限制 (W)'},
  {addr: 0x006b, name: 'PL2', kind: 'power', note: '短时功耗限制 (W)'},
  {addr: 0x006e, name: 'PL3', kind: 'power', note: 'PL3 (W)'},
  {addr: 0x006f, name: 'PL4', kind: 'power', note: 'PL4 (W)'},
  {addr: 0x008a, name: 'LDAT', kind: 'byte', note: 'EC 命令邮箱 低数据'},
  {addr: 0x008b, name: 'HDAT', kind: 'byte', note: 'EC 命令邮箱 高数据'},
  {addr: 0x008f, name: 'CMDL', kind: 'byte', note: 'EC 命令邮箱 低命令'},
]

function parseCall(text) {
  const t = String(text).trim().replace(/\0/g, '')
  if (!t) return {error: 'empty'}
  const hex = t.match(/^0x([0-9a-fA-F]+)$/)
  if (hex) return {value: parseInt(hex[1], 16), raw: t}
  const braced = t.match(/^\{\s*([^}]*)\}/)
  if (braced) {
    const nums = braced[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => parseInt(s, 16))
    if (nums.length === 1) return {value: nums[0], raw: t}
    return {bytes: nums, raw: t}
  }
  if (/error/i.test(t)) return {error: t}
  const n = Number(t)
  return Number.isFinite(n) ? {value: n, raw: t} : {error: t}
}

function ecRead(addr) {
  try {
    fs.writeFileSync(CALL, `${METHOD} 0x${addr.toString(16)}`)
  } catch (e) {
    return {error: `write: ${e.code || e.message}`}
  }
  try {
    return parseCall(fs.readFileSync(CALL, 'utf8'))
  } catch (e) {
    return {error: `read: ${e.code || e.message}`}
  }
}

function cpuTempC() {
  try {
    const zones = fs.readdirSync('/sys/class/hwmon')
    for (const z of zones) {
      const base = `/sys/class/hwmon/${z}`
      if (fs.readFileSync(`${base}/name`, 'utf8').trim() !== 'k10temp') continue
      const t = Number(fs.readFileSync(`${base}/temp1_input`, 'utf8').trim())
      return Number.isFinite(t) ? Math.round(t / 1000) : null
    }
  } catch {}
  return null
}

const report = {
  schema: 1,
  tool: 'jlc-ec',
  at: new Date().toISOString(),
  dry: DRY,
  privileged: process.getuid?.() === 0,
  method: METHOD,
  callPresent: fs.existsSync(CALL),
  known: [],
  windows: {},
  dump: null,
  verdict: [],
}

if (DRY) {
  // 只验证地址表与解码逻辑，不碰 /proc/acpi/call
  report.known = KNOWN.map((k) => ({...k, value: null, simulated: true}))
  report.verdict.push({level: 'info', text: `dry-run：地址表 ${KNOWN.length} 项，未访问硬件`})
} else {
  if (!report.privileged) {
    console.error('需要 root：sudo node probe/ec.mjs')
    process.exit(1)
  }
  if (!report.callPresent) {
    console.error('/proc/acpi/call 不存在：请先 sudo apt install acpi-call-dkms && sudo modprobe acpi_call')
    process.exit(1)
  }

  for (const k of KNOWN) {
    const r = ecRead(k.addr)
    report.known.push({...k, ...r, hex: r.value !== undefined ? '0x' + r.value.toString(16).padStart(2, '0') : null})
  }

  const readRange = (lo, hi) => {
    const out = {}
    for (let a = lo; a <= hi; a++) {
      const r = ecRead(a)
      out['0x' + a.toString(16).padStart(4, '0')] = r.value ?? (r.error ? `E:${r.error}` : null)
    }
    return out
  }
  if (FULL) {
    report.dump = readRange(0x0000, 0x0fff)
  } else {
    report.windows.low = readRange(0x0000, 0x00ff)
    report.windows.fan = readRange(0x0400, 0x04ff)
    report.windows.oem = readRange(0x0700, 0x07ff)
    report.windows.fantable = readRange(0x0f00, 0x0f5f)
    report.windows.duty = readRange(0x1800, 0x181f)
  }

  // ── 判定 ──
  const get = (n) => report.known.find((k) => k.name === n)
  const fanHi = get('CPU_RPM_HI')?.value
  const fanLo = get('CPU_RPM_LO')?.value
  const ecTemp = get('CPU_TEMP')?.value
  const sysTemp = cpuTempC()

  report.verdict.push({
    level: ecTemp !== undefined && ecTemp > 0 && ecTemp < 120 ? 'ok' : 'fail',
    text: `ECRR 通路${ecTemp !== undefined ? '可用' : '失败'}：0x043e=${ecTemp}` + (sysTemp ? `，k10temp=${sysTemp}°C` : ''),
  })
  if (ecTemp !== undefined && sysTemp) {
    const diff = Math.abs(ecTemp - sysTemp)
    report.verdict.push({
      level: diff <= 12 ? 'ok' : 'warn',
      text: `EC 温度与 k10temp 相差 ${diff}°C${diff <= 12 ? '（映射可信）' : '（偏差大，需核对地址）'}`,
    })
  }
  if (fanHi !== undefined && fanLo !== undefined) {
    const rpmA = fanHi * 256 + fanLo
    const rpmB = fanLo * 256 + fanHi
    const plausible = (v) => v > 300 && v < 7000
    report.verdict.push({
      level: plausible(rpmA) || plausible(rpmB) ? 'ok' : 'warn',
      text: `CPU 风扇候选：(hi<<8|lo)=${rpmA} RPM，(lo<<8|hi)=${rpmB} RPM`,
    })
  }
  const bare = get('BAREBONE_ID')?.value
  if (bare !== undefined) report.verdict.push({level: 'info', text: `机种 ID 0x0740 = 0x${bare.toString(16)}（蛟龙16K 为 0x10，本机不同属正常）`})
  const fanCtrl = get('FAN_CTRL_STATUS')?.value
  if (fanCtrl !== undefined) {
    report.verdict.push({
      level: fanCtrl & 0x40 ? 'ok' : 'warn',
      text: `风扇控制能力位 0x078e = 0x${fanCtrl.toString(16)}${fanCtrl & 0x40 ? '（bit6 置位：支持通用风扇控制）' : '（bit6 未置位：风扇控制可能不可用）'}`,
    })
  }
}

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n')

const lines = [
  `EC RAM 探针  ${report.at}  dry=${report.dry}  root=${report.privileged}`,
  '',
  '── 已知地址 ──',
  ...report.known.map((k) => `  ${k.addr.toString(16).padStart(4, '0')}  ${k.name.padEnd(16)} ${String(k.value ?? k.error ?? '-').padEnd(6)} ${k.note}`),
  '',
  '── 判定 ──',
  ...report.verdict.map((v) => `  [${v.level}] ${v.text}`),
  '',
  `完整数据: ${OUT_JSON}`,
]
fs.writeFileSync(OUT_TXT, lines.join('\n') + '\n')
process.stdout.write('\n' + lines.join('\n') + '\n')
