/**
 * 开机自动应用 —— daemon 启动时把 config 里勾选了"开机应用"的性能参数重放一遍。
 *
 * 背景：CPU/GPU/RyzenSMU 页的参数都是"点应用才写一次"，重启后 daemon 不读配置，
 * 于是设置页那 6 个"开机自动应用"开关全是装饰。这里把它们接上。
 *
 * 设计：planBootActions() 是纯函数（配置 → 动作清单），便于单测；
 * runBootActions() 负责执行并汇总成功/失败/跳过，由 daemon/index.mjs 调用。
 * 动作直接用 methods 表里的方法名，不重复实现一遍硬件写入。
 */

/** 配置里的档位名 → Cpu 段里的字段名 */
export const PROFILE_KEY = {
  default: 'Default',
  performance: 'Performance',
  saving: 'Saving',
  custom: 'Custom',
}

/** SMU 页"开机应用"可勾的参数（与 client/src/pages/RyzenSmu.vue 的 key 一致） */
export const SMU_BOOT_KEYS = [
  'StapmLimit',
  'StapmTime',
  'FastLimit',
  'SlowLimit',
  'SlowTime',
  'PptLimitRsmu',
  'VrmCurrentMp1',
  'VrmCurrentRsmu',
  'EdcLimitMp1',
  'EdcLimitRsmu',
  'TempLimitMp1',
  'TempLimitRsmu',
  'PboScalar',
  'OcClk',
  'OcVolt',
]

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 把配置翻译成动作清单。
 * @param {object} cfg daemon 的配置对象（config.mjs 的 DEFAULTS 深合并结果）
 * @returns {Array<{group: string, method: string, args: unknown[], label: string} | {skip: true, label: string}>}
 */
export function planBootActions(cfg) {
  const actions = []
  if (!cfg || typeof cfg !== 'object') return actions
  const app = cfg.App ?? {}
  const cpu = cfg.Cpu ?? {}
  const smu = cfg.Smu ?? {}

  // ① CPU 参数（功耗/温度墙/最大频率/睿频）
  if (app.BootAdvancedCPUSystem) {
    const profileName = PROFILE_KEY[cpu.CpuProfile] ?? 'Default'
    const p = cpu[profileName] ?? cpu.Default
    if (!p) {
      actions.push({skip: true, label: `CPU 档位 ${cpu.CpuProfile ?? 'default'} 无数据`})
    } else {
      actions.push({
        group: 'CPU',
        method: 'SetCpuLongPower',
        args: [num(p.CpuLongPower)],
        label: `长时功耗 ${p.CpuLongPower}W`,
      })
      actions.push({
        group: 'CPU',
        method: 'SetCpuShortPower',
        args: [num(p.CpuShortPower)],
        label: `短时功耗 ${p.CpuShortPower}W`,
      })
      actions.push({
        group: 'CPU',
        method: 'SetCPUTempWall',
        args: [num(p.CpuTempWall)],
        label: `温度墙 ${p.CpuTempWall}℃`,
      })
      actions.push({
        group: 'Power',
        method: 'SetCPUMaxFrequency',
        args: [num(p.CpuMaxFrequency)],
        label: `最大频率 ${p.CpuMaxFrequency}MHz`,
      })
      const turbo = p.CpuTurbo !== false
      actions.push({
        group: 'Power',
        method: turbo ? 'EnableTurbo' : 'DisableTurbo',
        args: [],
        label: turbo ? '开启睿频' : '关闭睿频',
      })
    }
  }

  // ② GPU 参数：Linux 没有 NVAPI 频率/曲线接口，明确记为跳过而不是静默
  if (app.BootAdvancedGPUSystem) {
    actions.push({skip: true, label: 'GPU 参数自动应用：Linux 无 NVAPI 频率接口，跳过'})
  }

  // ③ RyzenSMU Curve Optimizer（全核 / 分核）
  if (app.BootSetRyzenSmuCurveOptimizerAll) {
    if (app.BootSetRyzenSmuCurveOptimizerPerCore) {
      const per = Array.isArray(smu.CurveOptimizerPerCore) ? smu.CurveOptimizerPerCore : []
      let count = 0
      per.forEach((v, i) => {
        const n = num(v)
        if (!n) return // 0 表示该核没设偏移
        count++
        actions.push({
          group: 'RyzenSmu',
          method: 'SetCurveOptimizerPerCore',
          args: [i, n],
          label: `核心 ${i} CO ${n}`,
        })
      })
      if (count === 0) actions.push({skip: true, label: '分核 CO 全为 0，未设置任何偏移'})
    } else {
      const all = num(smu.CurveOptimizerAll)
      if (all) {
        actions.push({
          group: 'RyzenSmu',
          method: 'SetCurveOptimizerAll',
          args: [all],
          label: `全核 CO ${all}`,
        })
      } else {
        actions.push({skip: true, label: '全核 CO 为 0，未设置偏移'})
      }
    }
  }

  // ④ RyzenSMU 页里逐项勾选的参数。0 视为"未设置"（DEFAULTS 里全是 0）
  const bootItems = Array.isArray(smu.BootApplyItems) ? smu.BootApplyItems : []
  for (const key of bootItems) {
    if (!SMU_BOOT_KEYS.includes(key)) {
      actions.push({skip: true, label: `未知的 SMU 参数 ${key}，跳过`})
      continue
    }
    const v = num(smu[key])
    if (!v) {
      actions.push({skip: true, label: `SMU ${key}=0 视为未设置，跳过`})
      continue
    }
    actions.push({group: 'RyzenSmu', method: `Set${key}`, args: [v], label: `SMU ${key}=${v}`})
  }

  // ⑤ 自动风扇曲线控制（放最后：先设功耗/温度墙，再接管转速）
  if (app.BootAdvancedFanControlSystem) {
    actions.push({group: 'AutoFan', method: 'Start', args: [], label: '启动自动风扇曲线控制'})
  }

  return actions
}

/**
 * 依次执行动作，汇总结果。单条失败不中断后续。
 * @param {Array} actions planBootActions 的输出
 * @param {(group: string, method: string, args: unknown[]) => Promise<{Success?: boolean, Message?: string}>} call
 */
export async function runBootActions(actions, call) {
  const applied = []
  const failed = []
  const skipped = []
  for (const action of actions) {
    if (action.skip) {
      skipped.push(action.label)
      continue
    }
    try {
      const res = await call(action.group, action.method, action.args)
      if (res?.Success === false) failed.push(`${action.label}: ${res.Message ?? '失败'}`)
      else applied.push(action.label)
    } catch (e) {
      failed.push(`${action.label}: ${e?.message ?? e}`)
    }
  }
  return {applied, failed, skipped}
}
