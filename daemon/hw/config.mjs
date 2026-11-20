/** 配置持久化：JSON 文件，字段与前端 JiaoLongConfigType 一致 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = process.env.JLC_CONFIG || '/etc/jlc/config.json'

const cpuProfile = (longPower, shortPower, tempWall, maxFreq, turbo) => ({
  CpuLongPower: longPower,
  CpuShortPower: shortPower,
  CpuTempWall: tempWall,
  CpuMaxFrequency: maxFreq,
  CpuTurbo: turbo,
})

export const DEFAULTS = {
  Version: '1.0.0',
  App: {
    BootMinimized: false,
    BootAdvancedFanControlSystem: false,
    BootAdvancedCPUSystem: false,
    BootAdvancedGPUSystem: false,
    BootSetRyzenSmuCurveOptimizerAll: false,
    BootSetRyzenSmuCurveOptimizerPerCore: false,
    BootKeyboardGradient: false,
    CpuCurveOptimizerPerCore: false,
    BootGpuUseAdvancedOffsets: false,
    Theme: 'system',
    WindowWidth: 0,
    WindowHeight: 0,
  },
  Cpu: {
    CpuProfile: 'default',
    Default: cpuProfile(55, 75, 95, 4400, true),
    Performance: cpuProfile(75, 90, 95, 4700, true),
    Saving: cpuProfile(35, 45, 90, 3800, false),
    Custom: cpuProfile(55, 75, 95, 4800, true),
  },
  Gpu: {GpuClock: 0, MemoryClock: 0, CoreClockOffsetMhz: 0, MemoryClockOffsetMhz: 0},
  Fan: {
    FanCurveMerge: true,
    ManualFanSpeed: 50,
    CpuFanCurve: [
      {temp: 30, speed: 0},
      {temp: 50, speed: 30},
      {temp: 70, speed: 60},
      {temp: 85, speed: 85},
      {temp: 95, speed: 100},
    ],
    GpuFanCurve: [
      {temp: 30, speed: 0},
      {temp: 55, speed: 30},
      {temp: 70, speed: 60},
      {temp: 85, speed: 85},
      {temp: 95, speed: 100},
    ],
  },
  Smu: {
    StapmLimit: 0,
    StapmTime: 0,
    FastLimit: 0,
    SlowLimit: 0,
    SlowTime: 0,
    PptLimitRsmu: 0,
    VrmCurrentMp1: 0,
    VrmCurrentRsmu: 0,
    EdcLimitMp1: 0,
    EdcLimitRsmu: 0,
    TempLimitMp1: 0,
    TempLimitRsmu: 0,
    PboScalar: 0,
    OcClk: 0,
    OcVolt: 0,
    CurveOptimizerAll: 0,
    CurveOptimizerPerCore: new Array(16).fill(0),
    BootApplyItems: [],
  },
  Osd: {
    Enabled: false,
    ShowVolume: true,
    ShowLockKeys: true,
    ShowKeyboardBacklight: true,
    ShowPerformanceMode: true,
    ShowPerfTelemetry: false,
    ShowFnLock: true,
    ShowTouchpad: true,
    ShowMedia: true,
    SuppressNativeVolumeOsd: false,
    AnimationMs: 180,
    DurationMs: 1600,
    PollIntervalMs: 200,
    Position: 'BottomCenter',
    CustomX: 0,
    CustomY: 0,
    Opacity: 0.92,
    Scale: 1,
  },
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? [...base] : {...base}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v
  }
  return out
}

let cached = null

const PROFILES = ['Default', 'Performance', 'Saving', 'Custom']

export function loadConfig() {
  if (cached) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    cached = deepMerge(DEFAULTS, raw)
  } catch {
    cached = structuredClone(DEFAULTS)
  }
  // 迁移：早期版本把 CpuMaxFrequency 留成 0，等于"每次应用都失败"，这里补成出厂值
  for (const name of PROFILES) {
    const profile = cached.Cpu?.[name]
    if (profile && !Number(profile.CpuMaxFrequency)) {
      profile.CpuMaxFrequency = DEFAULTS.Cpu[name].CpuMaxFrequency
    }
  }
  return cached
}

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch ?? {})
  fs.mkdirSync(path.dirname(FILE), {recursive: true})
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n')
  cached = next
  return next
}
