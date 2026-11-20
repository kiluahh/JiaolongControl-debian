/** /proc 与 /sys 只读采样 */
import fs from 'node:fs'

export const readText = (p, dflt = null) => {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch {
    return dflt
  }
}

export function cpuTempC() {
  for (const h of (readText('/sys/class/hwmon', '') || '').split('\n').filter(Boolean)) {
    const base = `/sys/class/hwmon/${h}`
    if (readText(`${base}/name`) !== 'k10temp') continue
    const v = Number(readText(`${base}/temp1_input`))
    if (Number.isFinite(v)) return Math.round(v / 1000)
  }
  return null
}

export function gpuTempAmd() {
  for (const h of (readText('/sys/class/hwmon', '') || '').split('\n').filter(Boolean)) {
    const base = `/sys/class/hwmon/${h}`
    if (readText(`${base}/name`) !== 'amdgpu') continue
    const v = Number(readText(`${base}/temp1_input`))
    if (Number.isFinite(v)) return Math.round(v / 1000)
  }
  return null
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
