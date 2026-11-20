/** NVIDIA / AMD 显卡只读采样 */
import {execFileSync} from 'node:child_process'

const SMI = '/usr/bin/nvidia-smi'
const FIELDS = [
  'name',
  'driver_version',
  'memory.total',
  'clocks.current.graphics',
  'clocks.current.memory',
  'clocks.max.graphics',
  'temperature.gpu',
  'utilization.gpu',
  'utilization.memory',
  'fan.speed',
  'power.draw',
  'pstate',
]

let cache = {at: 0, data: null}

function parseCsv(line) {
  return line.split(',').map((s) => s.trim())
}

function num(v) {
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** 1 秒缓存：一次 nvidia-smi 拿全字段，避免每个 getter 各起一个进程 */
export function nvidia() {
  const now = Date.now()
  if (cache.data && now - cache.at < 1000) return cache.data
  let data = null
  try {
    const out = execFileSync(SMI, [`--query-gpu=${FIELDS.join(',')}`, '--format=csv,noheader,nounits'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const cols = parseCsv(out.split('\n')[0])
    if (cols.length >= FIELDS.length) {
      data = {
        name: cols[0],
        driverVersion: cols[1],
        memoryTotal: `${cols[2]} MiB`,
        coreClockMhz: num(cols[3]),
        memClockMhz: num(cols[4]),
        maxCoreClockMhz: num(cols[5]),
        tempC: num(cols[6]),
        utilPct: num(cols[7]),
        memUtilPct: num(cols[8]),
        fanPct: num(cols[9]),
        powerW: num(cols[10]),
        pstate: cols[11],
      }
    }
  } catch {
    data = null
  }
  cache = {at: now, data}
  return data
}

export function nvidiaAvailable() {
  return nvidia() !== null
}
