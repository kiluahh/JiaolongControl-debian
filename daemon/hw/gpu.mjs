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

// ── 频率锁定（nvidia-smi -lgc / -lmc）──────────────────────────────────────
/**
 * 前端 GPU 页的"最低频率"滑条语义是**下限**（负载时可继续睿频到驱动上限），
 * 在 Linux 上正好对应 `nvidia-smi -lgc <min>,<max>`（-lmc 同理）。
 *
 * 驱动只接受它自己支持的档位：实测 `-lmc 8001` 返回 All done 但显存时钟纹丝不动，
 * 而 `-lmc 9001` 立刻生效。所以写入前必须先吸附到支持档位，否则就是"看起来成功、
 * 实际没执行"的假控件。`--query-supported-clocks` 给出全部档位（本机 gr 180..3090
 * 共 389 档、mem 405/810/9001/11001/12001 共 5 档）。
 */

/**
 * 解析 `--query-supported-clocks` 的 CSV 输出。每行形如 `180 MHz`（或 nounits 的 `180`）。
 * 只认第一段数字，去重后升序。
 */
export function parseClockCsv(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const line of text.split('\n')) {
    const m = line.match(/\d+(?:\.\d+)?/)
    if (!m) continue
    const n = Number(m[0])
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * 把用户要的下限吸附到驱动支持档位。
 * 语义是"至少 N MHz"，所以取 >= N 的最小档位；N 不低于最高档就取最高档。
 * N <= 0（0 在配置里表示"不限制"）、无效值、或没有可用档位 → null。
 */
export function snapFloor(value, supported) {
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0) return null
  const list = Array.isArray(supported) ? [...supported].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b) : []
  if (!list.length) return null
  return list.find((c) => c >= v) ?? list[list.length - 1]
}

/** 跑一次 nvidia-smi，失败时不抛异常 */
function runSmi(args) {
  try {
    const out = execFileSync(SMI, args, {encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'pipe']})
    return {ok: true, out: out.trim(), err: ''}
  } catch (e) {
    const raw = e?.stderr ? String(e.stderr) : e?.message || ''
    const err = raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('+') && !s.startsWith('at '))[0]
    return {ok: false, out: '', err: err ?? 'nvidia-smi 执行失败'}
  }
}

const CLOCK_KIND = {
  gr: {flag: '-lgc', reset: '-rgc', label: '核心频率', field: 'clocks.current.graphics'},
  mem: {flag: '-lmc', reset: '-rmc', label: '显存频率', field: 'clocks.current.memory'},
}

const supportedCache = new Map()

/** 驱动支持的档位（升序）。读不到返回空数组（下次调用会重试）。 */
export function supportedClocks(kind) {
  if (supportedCache.has(kind)) return supportedCache.get(kind)
  const spec = CLOCK_KIND[kind]
  if (!spec) return []
  const r = runSmi([`--query-supported-clocks=${kind}`, '--format=csv,noheader,nounits'])
  const list = r.ok ? parseClockCsv(r.out) : []
  if (list.length) supportedCache.set(kind, list)
  return list
}

/**
 * 区间给前端：Min 固定为 0 表示"不限制"，Max 是驱动最高档。
 * 不使用"最低支持档"当下限，否则默认配置 0 会被前端夹到某个具体频率。
 */
export function clockRange(kind) {
  const list = supportedClocks(kind)
  if (!list.length) return null
  return {min: 0, max: list[list.length - 1]}
}

/** 读当前实际频率（MHz），用于写入后的参考回读 */
function currentClock(kind) {
  const spec = CLOCK_KIND[kind]
  const r = runSmi([`--query-gpu=${spec.field}`, '--format=csv,noheader,nounits'])
  if (!r.ok) return null
  const n = Number(r.out.split('\n')[0].trim())
  return Number.isFinite(n) ? n : null
}

/** 解除限制 */
export function resetClock(kind) {
  const spec = CLOCK_KIND[kind]
  if (!spec) return {ok: false, message: `未知频率类型: ${kind}`}
  const r = runSmi([spec.reset])
  if (!r.ok) return {ok: false, message: `解除${spec.label}限制失败：${r.err}`}
  return {ok: true, applied: 0, message: `${spec.label}限制已解除`}
}

/**
 * 锁定下限。value <= 0 → 解除限制（与"0 = 不限制"的配置语义一致）。
 * 返回值里的 applied 是**实际生效**的档位，可能与请求值不同（吸附过）。
 */
export function lockClock(kind, value) {
  const spec = CLOCK_KIND[kind]
  if (!spec) return {ok: false, message: `未知频率类型: ${kind}`}
  const list = supportedClocks(kind)
  if (!list.length) return {ok: false, message: `读不到${spec.label}支持档位（nvidia-smi 不可用？）`}
  const target = snapFloor(value, list)
  if (target === null) return resetClock(kind)
  const max = list[list.length - 1]
  const r = runSmi([spec.flag, `${target},${max}`])
  if (!r.ok) return {ok: false, message: `锁定${spec.label}失败：${r.err}`}
  const cur = currentClock(kind)
  const snapped = target !== Math.round(Number(value)) ? `（请求 ${Math.round(Number(value))}，吸附到驱动支持的档位）` : ''
  return {
    ok: true,
    applied: target,
    message: `${spec.label}下限已设为 ${target} MHz${snapped}，负载时可继续睿频到 ${max} MHz${cur !== null ? `；当前 ${cur} MHz` : ''}`,
  }
}
