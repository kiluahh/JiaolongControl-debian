/**
 * RAPL 功耗读取（powercap）。
 *
 * 本机（AMD Ryzen 9 8940HX）由 intel_rapl_msr 驱动暴露了标准 powercap 接口：
 *   /sys/class/powercap/intel-rapl:0/          name=package-0  整包
 *   /sys/class/powercap/intel-rapl:0:0/        name=core       核心域
 *   energy_uj 是累计能量（微焦），权限 0400 → 只有 root（即 daemon）能读。
 *
 * 由能量差分算平均功率：W = ΔμJ / 1e6 / Δs。
 * 计数器会回绕（max_energy_range_uj，本机 65532610987），需要处理。
 *
 * 纯函数与 IO 分离，便于单测。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_ROOT = '/sys/class/powercap'

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch {
    return null
  }
}

function readNumber(p) {
  const t = readText(p)
  if (t === null) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** 找 package-0 域；找不到就退化为第一个带 energy_uj 的域 */
export function findPackageDomain(root = DEFAULT_ROOT) {
  let entries
  try {
    entries = fs.readdirSync(root)
  } catch {
    return null
  }
  const candidates = entries.map((n) => path.join(root, n)).filter((d) => {
    try {
      return fs.statSync(d).isDirectory()
    } catch {
      return false
    }
  })
  for (const dir of candidates) {
    if (readText(path.join(dir, 'name')) === 'package-0') return dir
  }
  for (const dir of candidates) {
    if (readNumber(path.join(dir, 'energy_uj')) !== null) return dir
  }
  return null
}

/**
 * 能量差（μJ），处理计数器回绕。
 * 任一参数无效时返回 null，不要拿 0 冒充。
 */
export function energyDelta(prev, cur, maxRange) {
  if (!Number.isFinite(prev) || !Number.isFinite(cur)) return null
  if (cur >= prev) return cur - prev
  if (Number.isFinite(maxRange) && maxRange > 0) return maxRange - prev + cur
  return null // 回绕但不知道量程 → 无法计算
}

/**
 * 由两次采样算平均功率（瓦）。
 * @param {{energy: number, at: number}} prev energy=μJ, at=毫秒时间戳
 * @param {{energy: number, at: number}} cur
 * @param {number} maxRange max_energy_range_uj
 */
export function wattsBetween(prev, cur, maxRange) {
  if (!prev || !cur) return null
  const d = energyDelta(prev.energy, cur.energy, maxRange)
  if (d === null) return null
  const dtS = (cur.at - prev.at) / 1000
  if (!(dtS > 0)) return null
  const w = d / 1e6 / dtS
  return Math.round(w * 10) / 10
}

/**
 * 创建功率采样器。第一次 sample() 只建立基线（返回 null），之后返回瓦数。
 * 采样间隔过短（<100ms）时返回上一次的结果，避免除零和抖动。
 */
export function createPowerSampler({root = DEFAULT_ROOT, now = () => Date.now()} = {}) {
  const dir = findPackageDomain(root)
  if (!dir) return {available: false, domain: null, sample: () => null}
  const energyPath = path.join(dir, 'energy_uj')
  const maxRange = readNumber(path.join(dir, 'max_energy_range_uj'))
  let prev = null
  let last = null
  return {
    available: true,
    domain: dir,
    sample() {
      const energy = readNumber(energyPath)
      const at = now()
      if (energy === null) return null
      if (prev && at - prev.at >= 100) {
        const w = wattsBetween(prev, {energy, at}, maxRange)
        prev = {energy, at}
        if (w !== null) last = w
      } else if (!prev) {
        prev = {energy, at}
      }
      return last
    },
  }
}
