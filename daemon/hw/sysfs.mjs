/** /proc 与 /sys 只读采样 */
import fs from 'node:fs'

export const readText = (p, dflt = null) => {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch {
    return dflt
  }
}

/**
 * 按 hwmon 名称读 temp1_input（℃）。
 * 注意：/sys/class/hwmon 是目录，必须 readdirSync；早先误用 readText 读目录
 * （EISDIR → 空串）导致温度恒为 null。
 */
export function hwmonTempC(name, root = '/sys/class/hwmon') {
  let entries
  try {
    entries = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const entry of entries) {
    const base = `${root}/${entry}`
    if (readText(`${base}/name`) !== name) continue
    // 注意：readText 失败返回 null，Number(null) 是 0 —— 必须先判 null，
    // 否则读不到温度时会返回 0℃ 这种假数据
    const raw = readText(`${base}/temp1_input`)
    if (raw === null || raw === '') continue
    const v = Number(raw)
    if (Number.isFinite(v)) return Math.round(v / 1000)
  }
  return null
}

export function cpuTempC(root) {
  return hwmonTempC('k10temp', root)
}

export function gpuTempAmd(root) {
  return hwmonTempC('amdgpu', root)
}

export function cpuFreqMhz() {
  const khz = Number(readText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'))
  if (Number.isFinite(khz) && khz > 0) return Math.round(khz / 1000)
  const mhz = Number(readText('/proc/cpuinfo')?.match(/cpu MHz\s*:\s*([\d.]+)/)?.[1])
  return Number.isFinite(mhz) ? Math.round(mhz) : 0
}

function statLine() {
  const line = (readText('/proc/stat', '') || '').split('\n')[0] || ''
  const n = line.trim().split(/\s+/).slice(1).map(Number)
  const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n
  const idleAll = idle + iowait
  const total = user + nice + sys + idle + iowait + irq + softirq + steal
  return {total, idle: idleAll}
}

let prevStat = statLine()

/**
 * 距离上次调用之间的 CPU 占用率（%）。
 * 首次调用或间隔过短时退回最近 100ms 采样，避免除以零。
 */
export function cpuUsage() {
  const now = statLine()
  const dt = now.total - prevStat.total
  const di = now.idle - prevStat.idle
  prevStat = now
  if (dt <= 0) return 0
  const usage = ((dt - di) / dt) * 100
  return Math.max(0, Math.min(100, Math.round(usage)))
}

export function cpuInfo() {
  const txt = readText('/proc/cpuinfo', '')
  const name = txt.match(/model name\s*:\s*(.+)/)?.[1]?.trim() ?? 'Unknown'
  const threads = (txt.match(/^processor\s*:/gm) ?? []).length
  const cores = physicalCores()
  const maxKhz = Number(readText('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', '0'))
  return {Name: name, Cores: cores, Threads: threads, BaseFreqMhz: Math.round(maxKhz / 1000)}
}

export function physicalCores() {
  const set = new Set()
  for (const d of fs.readdirSync('/sys/devices/system/cpu')) {
    if (!/^cpu\d+$/.test(d)) continue
    const coreId = readText(`/sys/devices/system/cpu/${d}/topology/core_id`)
    const pkgId = readText(`/sys/devices/system/cpu/${d}/topology/physical_package_id`)
    if (coreId !== null) set.add(`${pkgId}:${coreId}`)
  }
  return set.size || 1
}

export function memoryInfo() {
  const txt = readText('/proc/meminfo', '')
  const kb = (k) => Number(txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
  const total = kb('MemTotal')
  const avail = kb('MemAvailable')
  const gb = (v) => (v / 1024 / 1024).toFixed(1)
  return `${gb(total - avail)} / ${gb(total)} GB`
}

export function osPrettyName() {
  const txt = readText('/etc/os-release', '')
  return txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? 'Linux'
}

export function totalMemGb() {
  const txt = readText('/proc/meminfo', '')
  return Math.round(Number(txt.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0) / 1024 / 1024)
}
