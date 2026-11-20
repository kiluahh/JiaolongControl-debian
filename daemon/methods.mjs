/**
 * BridgeApi 方法表 —— 组名/方法名/参数与前端 client/src/utils/bridge.ts 完全一致。
 * 每个处理函数返回 {Success, Message, Data}。
 */
import fs from 'node:fs'
import {Ec, REG, MODE_BIT, CUME_BIT, FAN_DUTY_MAX, applyPerformanceMode} from './ec.mjs'
import * as sys from './hw/sysfs.mjs'
import {nvidia} from './hw/gpu.mjs'
import {loadConfig, saveConfig} from './hw/config.mjs'
import * as smu from './hw/smu.mjs'

const ec = new Ec()

const ok = (Data, Message = '成功') => ({Success: true, Message, Data})
const fail = (Message) => ({Success: false, Message})

const MAX_RPM_BYTE = 68 // 上游约定：1 byte = 100 RPM
const rpmByteToDuty = (b) => Math.max(0, Math.min(FAN_DUTY_MAX, Math.round((b / MAX_RPM_BYTE) * FAN_DUTY_MAX)))

function ecGuard(fn, label) {
  try {
    return fn()
  } catch (e) {
    return fail(`${label}: ${e.message}`)
  }
}

// ── 自动风扇控制 ────────────────────────────────────────────────────────────
const autoFan = {
  timer: null,
  target: 0,
  running: false,
  start() {
    if (this.timer) return
    this.running = true
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch {
        /* 单次失败不终止控制环 */
      }
    }, 1000)
  },
  stop() {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    ecGuard(() => ec.updateBit(REG.MODE, MODE_BIT.MANUAL_FAN, false), '停止自动风扇')
  },
  tick() {
    if (!ec.available) return
    const cfg = loadConfig()
    const manual = Number(cfg.Fan?.ManualFanSpeed ?? 0) // 0..100
    const temp = ec.tryRead(REG.CPU_TEMP, sys.cpuTempC() ?? 0)
    const curve = cfg.Fan?.CpuFanCurve ?? []
    let pct = manual
    if (curve.length >= 2) {
      pct = interpolate(curve, temp)
    }
    this.target = Math.max(0, Math.min(100, Math.round(pct)))
    const duty = Math.round((this.target / 100) * FAN_DUTY_MAX)
    ec.writeByte(REG.DUTY_CPU, duty)
    if (cfg.Fan?.FanCurveMerge) ec.writeByte(REG.DUTY_GPU, duty)
    ec.updateBit(REG.MODE, MODE_BIT.MANUAL_FAN, true)
  },
}

function interpolate(points, temp) {
  const pts = [...points].sort((a, b) => a.temp - b.temp)
  if (temp <= pts[0].temp) return pts[0].speed
  if (temp >= pts[pts.length - 1].temp) return pts[pts.length - 1].speed
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (temp <= b.temp) {
      const t = (temp - a.temp) / (b.temp - a.temp || 1)
      return a.speed + t * (b.speed - a.speed)
    }
  }
  return pts[pts.length - 1].speed
}

// ── 键盘渐变 ────────────────────────────────────────────────────────────────
const gradient = {
  timer: null,
  running: false,
  hue: 0,
  start() {
    if (this.timer) return
    this.running = true
    this.timer = setInterval(() => {
      this.hue = (this.hue + 4) % 360
      const {r, g, b} = hslToRgb(this.hue / 360, 1, 0.5)
      ecGuard(() => {
        ec.writeByte(REG.KBD_RGB_R, r)
        ec.writeByte(REG.KBD_RGB_G, g)
        ec.writeByte(REG.KBD_RGB_B, b)
        ec.updateBit(REG.KBD_RGB_MODE, 0x20, true)
      }, '键盘渐变')
    }, 120)
  },
  stop() {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return {r: f(0), g: f(8), b: f(4)}
}

// ── 方法表 ──────────────────────────────────────────────────────────────────
export const methods = {
  Sys: {
    Capabilities: () => ok({ec: ec.available, nvidia: nvidia() !== null, platform: 'uniwill-inou'}),
    Ping: () => ok('pong'),
  },

  CPU: {
    GetCPUThermometer: () =>
      ecGuard(() => {
        const v = ec.tryRead(REG.CPU_TEMP)
        if (v !== null) return ok(v)
        const s = sys.cpuTempC()
        return s !== null ? ok(s) : fail('温度不可用')
      }, 'CPU 温度'),
    GetCpuUsage: () => ok(sys.cpuUsage()),
    GetCpuInfo: () => ok(sys.cpuInfo()),
    GetCpuFrequency: () => ok(sys.cpuFreqMhz()),
    // AMD 平台没有暴露 core voltage 的 sysfs 节点，EC 侧也未确认对应寄存器
    GetCpuVoltage: () => fail('本机暂不支持 CPU 电压读取'),
    GetPhysicalCoreCount: () => ok(sys.physicalCores()),
    SetCpuShortPower: (watts) => smuSet('fastLimit', Number(watts) * 1000, `短时功耗 ${watts}W`),
    SetCpuLongPower: (watts) => smuSet('stapmLimit', Number(watts) * 1000, `长时功耗 ${watts}W`),
    SetCPUTempWall: (celsius) => smuSet('tempLimit', Number(celsius), `温度墙 ${celsius}℃`),
  },

  Fan: {
    GetFanSpeed: () =>
      ecGuard(() => {
        const cpu = ec.readWord(REG.CPU_RPM_HI, REG.CPU_RPM_LO)
        const gpu = ec.readWord(REG.GPU_RPM_HI, REG.GPU_RPM_LO)
        // 注意：上游 FanController 把 item2 映射为 CPU、item1 为 GPU，此处直接按本机布局返回
        return ok({CPUFanSpeed: cpu, GPUFanSpeed: gpu})
      }, '风扇转速'),
    SetFanSpeed: (fanByte) =>
      ecGuard(() => {
        const duty = rpmByteToDuty(Number(fanByte) || 0)
        ec.writeByte(REG.DUTY_CPU, duty)
        ec.writeByte(REG.DUTY_GPU, duty)
        ec.updateBit(REG.MODE, MODE_BIT.MANUAL_FAN, true)
        return ok(undefined, `已设为 ${Math.round((duty / FAN_DUTY_MAX) * 100)}%`)
      }, '设置风扇'),
    RemoveFanSpeed: () =>
      ecGuard(() => {
        ec.updateBit(REG.MODE, MODE_BIT.MANUAL_FAN, false)
        return ok(undefined, '已交回 EC 自动控制')
      }, '恢复风扇'),
    // 前端未直接调用，但 Windows 版有：全速开关
    GetMaxFanSpeedSwitch: () =>
      ecGuard(() => ok(!!(ec.readByte(REG.FAN_CTRL_STATUS) & 0x40)), '风扇能力'),
  },

  PerformanceMode: {
    // 依据本机 DSDT 的 PMSC：CUME→3(自定义) / TBME→2(性能) / UFME→0(安静) / 都不置位→1(平衡)
    Get: () =>
      ecGuard(() => {
        const m = ec.readByte(REG.MODE)
        const c = ec.readByte(REG.CUME)
        if (c & CUME_BIT) return ok(0, '当前为自定义档（界面只支持三档）')
        if (m & MODE_BIT.TBME) return ok(1)
        if (m & MODE_BIT.UFME) return ok(2)
        return ok(0)
      }, '读取性能模式'),
    Set: (mode) =>
      ecGuard(() => {
        const m = Number(mode)
        const cur = ec.readByte(REG.MODE)
        const cume = ec.readByte(REG.CUME)
        // 切档时退出自定义档与手动风扇，保留 EC 维护的其它位
        ec.writeByte(REG.CUME, cume & ~CUME_BIT)
        const base = cur & ~(MODE_BIT.TBME | MODE_BIT.UFME | MODE_BIT.MANUAL_FAN)
        const next = m === 1 ? base | MODE_BIT.TBME : m === 2 ? base | MODE_BIT.UFME : base
        ec.writeByte(REG.MODE, next)
        const readBack = ec.readByte(REG.MODE)
        applyPerformanceMode() // 让固件应用该档位的风扇策略
        const name = m === 1 ? '性能' : m === 2 ? '安静' : '平衡'
        return ok(undefined, `已切到${name}档（0x0751=0x${readBack.toString(16)}）`)
      }, '设置性能模式'),
  },

  Keyboard: {
    GetColor: () =>
      ecGuard(
        () => ok({red: ec.readByte(REG.KBD_RGB_R), green: ec.readByte(REG.KBD_RGB_G), blue: ec.readByte(REG.KBD_RGB_B)}),
        '读取键盘颜色',
      ),
    SetColor: (r, g, b) =>
      ecGuard(() => {
        ec.writeByte(REG.KBD_RGB_R, Number(r) & 0xff)
        ec.writeByte(REG.KBD_RGB_G, Number(g) & 0xff)
        ec.writeByte(REG.KBD_RGB_B, Number(b) & 0xff)
        ec.updateBit(REG.KBD_RGB_MODE, 0x20, true) // bit5 = 应用颜色
        return ok(undefined, '颜色已应用')
      }, '设置键盘颜色'),
    GetLightBrightness: () => ecGuard(() => ok(ec.readByte(REG.KBD_BL_STATUS) & 0x03), '读取键盘亮度'),
    SetLightBrightness: () => fail('键盘亮度寄存器尚未确认，暂不写入'),
  },

  LogoLight: {
    Get: () => fail('logo 灯寄存器尚未确认'),
    Set: () => fail('logo 灯寄存器尚未确认'),
  },

  GPU: {
    // 混合显卡机型：固件层面的独显直连开关未在 ACPI 中找到
    Get: () => ok(0),
    Set: () => fail('本机未找到显卡模式切换接口'),
  },

  ConfigCtrl: {
    GetConfig: () => ok(loadConfig()),
    SetConfig: (json) => {
      try {
        const patch = typeof json === 'string' ? JSON.parse(json) : json
        saveConfig(patch)
        return ok(undefined, '保存成功')
      } catch (e) {
        return fail(`配置无效: ${e.message}`)
      }
    },
  },

  AutoStart: {
    Enable: () => {
      try {
        fs.mkdirSync('/etc/xdg/autostart', {recursive: true})
        fs.writeFileSync(
          '/etc/xdg/autostart/jiaolong.desktop',
          '[Desktop Entry]\nType=Application\nName=JiaoLongControl\nExec=jiaolong\nX-GNOME-Autostart-enabled=true\n',
        )
        return ok(undefined, '已设置开机自启')
      } catch (e) {
        return fail(e.message)
      }
    },
    Disable: () => {
      try {
        fs.rmSync('/etc/xdg/autostart/jiaolong.desktop', {force: true})
        return ok(undefined, '已取消开机自启')
      } catch (e) {
        return fail(e.message)
      }
    },
    IsEnabled: () => ok(fs.existsSync('/etc/xdg/autostart/jiaolong.desktop')),
  },

  AutoFan: {
    Start: () => {
      autoFan.start()
      return ok(undefined, '自动风扇已启动')
    },
    Stop: () => {
      autoFan.stop()
      return ok(undefined, '自动风扇已停止')
    },
    IsRunning: () => ok(autoFan.running),
  },

  KeyboardGradient: {
    Start: () => {
      gradient.start()
      return ok(undefined, '键盘渐变已启动')
    },
    Stop: () => {
      gradient.stop()
      return ok(undefined, '键盘渐变已停止')
    },
    IsRunning: () => ok(gradient.running),
  },

  NvidiaGpu: {
    GetGpuName: () => gpuField('name', 'N/A'),
    GetGpuDriverVersion: () => gpuField('driverVersion', 'N/A'),
    GetGpuDriverDate: () => ok('N/A'),
    GetGpuMemoryTotal: () => gpuField('memoryTotal', 'N/A'),
    GetGpuBusWidth: () => ok('N/A'),
    GetGpuUtilization: () => gpuNum('utilPct'),
    GetGpuMemoryUtilization: () => gpuNum('memUtilPct'),
    GetGpuCoreClock: () => gpuNum('coreClockMhz'),
    GetGpuMemoryClock: () => gpuNum('memClockMhz'),
    GetGpuTemperature: () => gpuNum('tempC'),
    GetGpuFanSpeed: () => gpuNum('fanPct'),
    GetGpuCoreClockRange: () => fail('Linux 无 NVAPI 频率范围接口'),
    GetGpuMemoryClockRange: () => fail('Linux 无 NVAPI 频率范围接口'),
    LockGpuClock: () => fail('暂未实现（需 nvidia-smi -lgc）'),
    ResetGpuClock: () => fail('暂未实现'),
    LockMemoryClock: () => fail('暂未实现'),
    ResetMemoryClock: () => fail('暂未实现'),
    GetGpuCurveCapabilities: () => ok({Supported: false, Reason: 'Linux 无 NVAPI VF 曲线接口', GpuName: '', CoreOffsetMinMhz: 0, CoreOffsetMaxMhz: 0}),
    GetGpuCurveStatus: () => fail('Linux 无 NVAPI VF 曲线接口'),
    SetGpuOffsets: () => fail('Linux 无 NVAPI VF 曲线接口'),
    ResetGpuCurve: () => fail('Linux 无 NVAPI VF 曲线接口'),
  },

  Power: {
    SetCPUMaxFrequency: async (mhz) => {
      const want = Number(mhz)
      if (!Number.isFinite(want) || want < 0) return fail(`频率值无效: ${mhz}`)
      const base = '/sys/devices/system/cpu/cpufreq'
      const readNum = (f) => {
        try {
          return Number(fs.readFileSync(f, 'utf8').trim())
        } catch {
          return null
        }
      }
      let policies = []
      try {
        policies = fs.readdirSync(base).filter((d) => d.startsWith('policy'))
      } catch (e) {
        return fail(`读取 cpufreq 失败: ${e.message}`)
      }
      if (!policies.length) return fail('没有找到 cpufreq policy')

      // 0 表示"不限制"：取硬件上限
      const resolved = want > 0 ? want : Math.round((readNum(`${base}/policy0/cpuinfo_max_freq`) ?? 5385000) / 1000)

      const writeErrors = []
      for (const p of policies) {
        const dir = `${base}/${p}`
        const maxFile = `${dir}/scaling_max_freq`
        const minFile = `${dir}/scaling_min_freq`
        try {
          if (!fs.existsSync(maxFile)) continue
          const infoMax = readNum(`${dir}/cpuinfo_max_freq`)
          const infoMin = readNum(`${dir}/cpuinfo_min_freq`)
          let target = Math.round(resolved * 1000)
          if (infoMax && target > infoMax) target = infoMax
          if (infoMin && target < infoMin) target = infoMin
          // 目标低于当前 min 时先降 min，否则 EINVAL
          const curMin = readNum(minFile)
          if (curMin && target < curMin) fs.writeFileSync(minFile, String(target))
          fs.writeFileSync(maxFile, String(target))
        } catch (e) {
          writeErrors.push({p, why: e.code ?? e.message})
        }
      }

      if (writeErrors.length === policies.length) {
        const head = writeErrors.slice(0, 3).map((f) => `${f.p}=${f.why}`).join(', ')
        return fail(`全部策略写入失败: ${head}`)
      }

      // 回读只作参考：驱动对 32 个 policy 的更新可能滞后，不一致不应判失败
      await new Promise((r) => setTimeout(r, 60))
      const targetHz = Math.round(resolved * 1000)
      const stale = policies.filter((p) => {
        const v = readNum(`${base}/${p}/scaling_max_freq`)
        return v !== null && v !== targetHz
      })
      const notes = []
      if (writeErrors.length) notes.push(`${writeErrors.length} 个策略写入报错`)
      if (stale.length) notes.push(`${stale.length} 个策略回读与目标不同（可能被驱动/电源服务调整）`)
      const label = want > 0 ? `${Math.round(resolved)}MHz` : `自动（上限 ${Math.round(resolved)}MHz）`
      return ok(undefined, `最大频率已设为 ${label}${notes.length ? '（' + notes.join('；') + '）' : ''}`)
    },
    DisableTurbo: () => setBoost(false),
    EnableTurbo: () => setBoost(true),
    GetCpuFreqLimits: () => {
      const base = '/sys/devices/system/cpu/cpufreq'
      try {
        const p = fs.readdirSync(base).find((d) => d.startsWith('policy')) ?? 'policy0'
        const readNum = (f) => {
          try {
            return Number(fs.readFileSync(`${base}/${p}/${f}`, 'utf8').trim())
          } catch {
            return null
          }
        }
        return ok({
          min: readNum('cpuinfo_min_freq'),
          max: readNum('cpuinfo_max_freq'),
          scalingMin: readNum('scaling_min_freq'),
          scalingMax: readNum('scaling_max_freq'),
          governor: fs.existsSync(`${base}/${p}/scaling_governor`) ? fs.readFileSync(`${base}/${p}/scaling_governor`, 'utf8').trim() : null,
        })
      } catch (e) {
        return fail(e.message)
      }
    },
  },

  SystemInfo: {
    GetSystemOverview: () => {
      const g = nvidia()
      return ok({
        CpuName: sys.cpuInfo().Name,
        GpuName: g?.name ?? 'AMD Radeon Graphics',
        OsVersion: sys.osPrettyName(),
        MemoryInfo: sys.memoryInfo(),
      })
    },
    OpenUrl: () => fail('由外壳负责打开链接'),
  },

  RyzenSmu: {
    GetSmuTelemetry: () =>
      ecGuard(() => {
        const temp = ec.tryRead(REG.CPU_TEMP, 0)
        return ok({Ppt: 0, Temp: temp, FreqMhz: sys.cpuFreqMhz(), Usage: sys.cpuUsage()})
      }, 'SMU 遥测'),

    SetStapmLimit: (watts) => smuSet('stapmLimit', Number(watts) * 1000, `STAPM 限值 ${watts}W`),
    SetStapmTime: (seconds) => smuSet('stapmTime', Number(seconds), `STAPM 时间 ${seconds}s`),
    SetFastLimit: (watts) => smuSet('fastLimit', Number(watts) * 1000, `Fast 限值 ${watts}W`),
    SetSlowLimit: (watts) => smuSet('slowLimit', Number(watts) * 1000, `Slow 限值 ${watts}W`),
    SetSlowTime: (seconds) => smuSet('slowTime', Number(seconds), `Slow 时间 ${seconds}s`),
    SetPptLimitRsmu: (watts) => smuSet('pptLimitRsmu', Number(watts) * 1000, `PPT 限值 ${watts}W`),
    SetVrmCurrentMp1: (ma) => smuSet('vrmCurrent', Number(ma), `VRM 电流 ${ma}mA`),
    SetVrmCurrentRsmu: (ma) => smuRsmuOnly(0x57, Number(ma), `VRM 电流(R) ${ma}mA`),
    SetEdcLimitMp1: (ma) => smuSet('edcLimit', Number(ma), `EDC 限值 ${ma}mA`),
    SetEdcLimitRsmu: (ma) => smuRsmuOnly(0x58, Number(ma), `EDC 限值(R) ${ma}mA`),
    SetTempLimitMp1: (c) => smuSet('tempLimit', Number(c), `温度墙 ${c}℃`),
    SetTempLimitRsmu: (c) => smuRsmuOnly(0x59, Number(c), `温度墙(R) ${c}℃`),
    SetPboScalar: (v) => smuSet('pboScalar', Number(v), `PBO Scalar ${v}`),
    SetOcClk: (mhz) => smuSet('ocClk', Number(mhz), `OC 频率 ${mhz}MHz`),
    SetPerCoreOcClk: (idx, mhz) =>
      smuSet('ocClkPerCore', ((Number(idx) << 8) | (Number(mhz) & 0xff)) >>> 0, `核心 ${idx} OC ${mhz}MHz`),
    SetOcVolt: (mv) => smuSet('ocVolt', Number(mv), `OC 电压 ${mv}mV`),
    EnableOc: () => smuSet('ocEnable', 0, 'OC 模式已开启'),
    DisableOc: () => smuSet('ocDisable', 0, 'OC 模式已关闭'),
    SetCurveOptimizerAll: (v) => smuSet('curveAll', Number(v) & 0xfffff, `全核 CO ${v}`),
    SetCurveOptimizerPerCore: (idx, v) => {
      const core = Number(idx)
      const val = Number(v)
      const margin = ((val < 0 ? 0x100000 : 0) + val) & 0xffff
      const arg = ((Math.floor(core / 8) << 28) | ((core % 8) << 20) | margin) >>> 0
      return smuSet('curveCore', arg, `核心 ${core} CO ${val}`)
    },
  },

  Osd: {
    ShowTest: () => fail('OSD 由外壳实现'),
    GetVolume: () => volumeGet(),
    SetVolume: (pct) => volumeSet(pct),
    SetMute: (muted) => volumeMute(muted),
    GetLockStates: () => ok({CapsLock: false, NumLock: false, FnLock: null, TouchpadLock: null}),
    SetCapsLock: () => fail('由外壳用 X11/Wayland 接口实现'),
    SetNumLock: () => fail('由外壳用 X11/Wayland 接口实现'),
    SetFnLock: () => fail('Fn 锁寄存器尚未确认'),
    SetTouchpadLock: () => fail('触摸板锁尚未确认'),
  },
}

// ── 辅助 ────────────────────────────────────────────────────────────────────
function smuSet(key, arg, label) {
  try {
    const c = smu.CMD[key]
    smu.sendAny(c.mp1, c.rsmu, arg)
    return ok(undefined, `${label} 已写入`)
  } catch (e) {
    return fail(e.message)
  }
}

function smuRsmuOnly(cmd, arg, label) {
  try {
    smu.send('rsmu', cmd, arg)
    return ok(undefined, `${label} 已写入`)
  } catch (e) {
    return fail(e.message)
  }
}

function gpuField(key, dflt) {
  const g = nvidia()
  return g ? ok(g[key] ?? dflt) : fail('nvidia-smi 不可用')
}

function gpuNum(key) {
  const g = nvidia()
  if (!g || g[key] === null || g[key] === undefined) return fail('nvidia-smi 不可用')
  return ok(g[key])
}

function setBoost(on) {
  const tried = []
  for (const p of ['/sys/devices/system/cpu/cpufreq/boost', '/sys/devices/system/cpu/boost']) {
    if (!fs.existsSync(p)) {
      tried.push(`${p}=不存在`)
      continue
    }
    try {
      fs.writeFileSync(p, on ? '1' : '0')
      const back = fs.readFileSync(p, 'utf8').trim()
      if (back === (on ? '1' : '0')) return ok(undefined, on ? '已开启睿频' : '已关闭睿频')
      tried.push(`${p}=回读 ${back}`)
    } catch (e) {
      tried.push(`${p}=${e.code ?? e.message}`)
    }
  }
  return fail(`睿频开关写入失败: ${tried.join('; ')}`)
}

let lastVolume = {Volume: 50, Muted: false}

function volumeGet() {
  return ok(lastVolume)
}

function volumeSet(pct) {
  const v = Math.max(0, Math.min(100, Math.round(Number(pct))))
  lastVolume = {...lastVolume, Volume: v}
  return ok(undefined, '音量由外壳应用到系统')
}

function volumeMute(muted) {
  lastVolume = {...lastVolume, Muted: !!muted}
  return ok(undefined, '静音由外壳应用到系统')
}

export function capabilities() {
  return {ec: ec.available, nvidia: nvidia() !== null}
}
