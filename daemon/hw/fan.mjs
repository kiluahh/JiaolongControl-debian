/**
 * 风扇转速单位换算 + 旧配置迁移。
 *
 * 背景（实测踩到的真 bug）：前端 Fan 页的滑条和风扇曲线编辑器用的都是 **RPM**
 * （Fan.vue 滑条 0..8000、曲线编辑器 speedRange 1500..6800），而 daemon 早期把
 * 收到的数字当成"EC 档位 / 百分比"处理：
 *
 *   旧: duty = clamp(rpm / 68 * 200)  → 任何 ≥68 的 RPM 都会被钳成 200（满转）
 *   旧: 曲线值当百分比 → RPM(1500..6800) 被 clamp 到 100% → 自动风扇恒满转
 *
 * 也就是说「手动风扇」和「自动风扇」只要从界面下发就一定是 100%。本模块把换算
 * 收敛到一处，并且只保留一个口径：**RPM**。
 *
 * EC 侧的量程：占空比寄存器 0x1804 / 0x1809 写 0..200，实测 150 ≈ 5363 RPM、
 * 200 ≈ 7100 RPM，即 200 ↔ 6800 RPM（1 档 ≈ 34 RPM），与曲线编辑器的上限一致。
 */

/** EC 占空比满量程对应的转速（RPM） */
export const FAN_MAX_RPM = 6800

/** 占空比寄存器量程（与 ec.mjs 的 FAN_DUTY_MAX 一致；此处复制一份避免循环依赖） */
export const FAN_DUTY_MAX = 200

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * RPM → EC 占空比（0..200）。非数字按 0 处理，超出量程钳位。
 */
export function rpmToDuty(rpm) {
  const v = Number(rpm)
  if (!Number.isFinite(v) || v <= 0) return 0
  return clamp(Math.round((v / FAN_MAX_RPM) * FAN_DUTY_MAX), 0, FAN_DUTY_MAX)
}

/** EC 占空比 → RPM（仅用于回显/日志） */
export function dutyToRpm(duty) {
  const v = Number(duty)
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.round((clamp(v, 0, FAN_DUTY_MAX) / FAN_DUTY_MAX) * FAN_MAX_RPM)
}

/**
 * 判断一段曲线是不是旧口径（百分比 0..100）。
 *
 * 早期版本 `config.mjs` 的默认曲线是 `{speed: 0..100}`，用户配置文件里可能还留着；
 * 而手动转速是前端直接写的 RPM —— 所以**两者必须分开判断**，实际遇到过
 * `ManualFanSpeed=5500` + 曲线仍是 0..100 的混合状态。
 * 若把百分比曲线当 RPM 用，95℃ 只会算出 100 RPM ≈ 3/200 占空比，风扇基本停转。
 */
export function isPercentCurve(curve) {
  const speeds = (Array.isArray(curve) ? curve : []).map((p) => Number(p?.speed)).filter((n) => Number.isFinite(n))
  if (!speeds.length) return false
  return speeds.every((s) => s >= 0 && s <= 100)
}

/** 单个转速值是否是旧的百分比口径 */
export function isPercentSpeed(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 100
}

/** 一份配置里只要有一部分是百分比口径，就需要迁移 */
export function isLegacyPercentFan(fan) {
  if (!fan || typeof fan !== 'object') return false
  return (
    isPercentCurve(fan.CpuFanCurve) ||
    isPercentCurve(fan.GpuFanCurve) ||
    (Number.isFinite(Number(fan.ManualFanSpeed)) && isPercentSpeed(fan.ManualFanSpeed))
  )
}

const pctToRpm = (pct) => clamp(Math.round((Number(pct) / 100) * FAN_MAX_RPM), 0, FAN_MAX_RPM)

const convertCurve = (curve) =>
  Array.isArray(curve)
    ? curve.map((p) => ({...p, speed: Number.isFinite(Number(p?.speed)) ? pctToRpm(p.speed) : 0}))
    : curve

/**
 * 把旧百分比口径就地迁移成 RPM（曲线、手动转速各自判断）。
 * 返回 `{fan, migrated}`，`migrated=false` 时原样返回；不修改入参。
 */
export function migrateFanConfig(fan) {
  if (!fan || typeof fan !== 'object') return {fan, migrated: false}
  const convertCurves = isPercentCurve(fan.CpuFanCurve) || isPercentCurve(fan.GpuFanCurve)
  const convertManual = Number.isFinite(Number(fan.ManualFanSpeed)) && isPercentSpeed(fan.ManualFanSpeed)
  if (!convertCurves && !convertManual) return {fan, migrated: false}
  return {
    fan: {
      ...fan,
      ManualFanSpeed: convertManual ? pctToRpm(fan.ManualFanSpeed) : fan.ManualFanSpeed,
      CpuFanCurve: isPercentCurve(fan.CpuFanCurve) ? convertCurve(fan.CpuFanCurve) : fan.CpuFanCurve,
      GpuFanCurve: isPercentCurve(fan.GpuFanCurve) ? convertCurve(fan.GpuFanCurve) : fan.GpuFanCurve,
    },
    migrated: true,
  }
}

/**
 * 温度 → 目标转速（RPM）。曲线点按温度升序，两端做钳位、中间线性插值。
 * 点不足 2 个时返回 `fallbackRpm`。
 */
export function curveRpm(points, tempC, fallbackRpm = 0) {
  const pts = (Array.isArray(points) ? points : [])
    .map((p) => ({temp: Number(p?.temp), speed: Number(p?.speed)}))
    .filter((p) => Number.isFinite(p.temp) && Number.isFinite(p.speed))
    .sort((a, b) => a.temp - b.temp)
  const t = Number(tempC)
  if (!pts.length) return fallbackRpm
  if (!Number.isFinite(t)) return clamp(pts[0].speed, 0, FAN_MAX_RPM)
  if (t <= pts[0].temp) return clamp(pts[0].speed, 0, FAN_MAX_RPM)
  const last = pts[pts.length - 1]
  if (t >= last.temp) return clamp(last.speed, 0, FAN_MAX_RPM)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (t <= b.temp) {
      const k = (t - a.temp) / (b.temp - a.temp || 1)
      return clamp(Math.round(a.speed + k * (b.speed - a.speed)), 0, FAN_MAX_RPM)
    }
  }
  return clamp(last.speed, 0, FAN_MAX_RPM)
}
