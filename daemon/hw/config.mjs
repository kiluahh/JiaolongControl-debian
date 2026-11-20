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
    BootAdvancedCPUSystem: false,
    BootAdvancedGPUSystem: false,
    BootSetRyzenSmuCurveOptimizerAll: false,
    BootSetRyzenSmuCurveOptimizerPerCore: false,
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
    // 只做系统自己不提示的四类：性能模式 / 风扇 / 键盘背光 / 触摸板
    ShowPerformanceMode: true,
    ShowFan: true,
    ShowKeyboardBacklight: true,
    ShowTouchpad: true,
    AnimationMs: 180,
    DurationMs: 1600,
    PollIntervalMs: 500,
    Position: 'BottomRight',
    CustomX: 50,
    CustomY: 92,
    Opacity: 92,
    Scale: 100,
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

/**
 * 清掉已下线功能的遗留字段：风扇曲线 / 自动风扇 / OSD 里用不到的开关。
 * 不清理的话旧 config.json 会被原样写回去，看着像还支持。
 */
function pruneLegacy(cfg) {
  delete cfg.Fan
  if (cfg.App) delete cfg.App.BootAdvancedFanControlSystem
  if (cfg.Osd) {
    for (const k of Object.keys(cfg.Osd)) if (!(k in DEFAULTS.Osd)) delete cfg.Osd[k]
    // 居中位置已取消（OSD 只贴屏幕左右角），旧配置落到右下
    const POSITIONS = ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight', 'Custom']
    if (!POSITIONS.includes(cfg.Osd.Position)) cfg.Osd.Position = 'BottomRight'
  }
}

export function loadConfig() {
  if (cached) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    cached = deepMerge(DEFAULTS, raw)
  } catch {
    cached = structuredClone(DEFAULTS)
  }
  pruneLegacy(cached)

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
  pruneLegacy(next)
  fs.mkdirSync(path.dirname(FILE), {recursive: true})
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n')
  cached = next
  return next
}
