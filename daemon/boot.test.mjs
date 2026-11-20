import test from 'node:test'
import assert from 'node:assert/strict'

import {planBootActions, runBootActions, PROFILE_KEY} from './boot.mjs'

/** 与 daemon/hw/config.mjs 的 DEFAULTS 同形的最小配置 */
function baseConfig(patch = {}) {
  return {
    App: {
      BootMinimized: false,
      BootAdvancedCPUSystem: false,
      BootAdvancedGPUSystem: false,
      BootSetRyzenSmuCurveOptimizerAll: false,
      BootSetRyzenSmuCurveOptimizerPerCore: false,
      BootGpuUseAdvancedOffsets: false,
      ...(patch.App ?? {}),
    },
    Cpu: {
      CpuProfile: 'default',
      Default: {CpuLongPower: 55, CpuShortPower: 75, CpuTempWall: 95, CpuMaxFrequency: 4400, CpuTurbo: true},
      Performance: {CpuLongPower: 75, CpuShortPower: 90, CpuTempWall: 95, CpuMaxFrequency: 4700, CpuTurbo: true},
      Saving: {CpuLongPower: 35, CpuShortPower: 45, CpuTempWall: 90, CpuMaxFrequency: 3800, CpuTurbo: false},
      Custom: {CpuLongPower: 60, CpuShortPower: 80, CpuTempWall: 92, CpuMaxFrequency: 4500, CpuTurbo: true},
      ...(patch.Cpu ?? {}),
    },
    Smu: {
      StapmLimit: 0,
      FastLimit: 0,
      TempLimitMp1: 0,
      CurveOptimizerAll: 0,
      CurveOptimizerPerCore: new Array(16).fill(0),
      BootApplyItems: [],
      ...(patch.Smu ?? {}),
    },
  }
}

const only = (actions) => actions.filter((a) => !a.skip)
const skips = (actions) => actions.filter((a) => a.skip).map((a) => a.label)

test('planBootActions：全部关闭时不产生任何动作', () => {
  assert.deepEqual(planBootActions(baseConfig()), [])
  assert.deepEqual(planBootActions(null), [])
  assert.deepEqual(planBootActions({}), [])
})

test('planBootActions：CPU 参数按当前档位重放', () => {
  const actions = planBootActions(baseConfig({App: {BootAdvancedCPUSystem: true}}))
  assert.deepEqual(
    only(actions).map((a) => [a.group, a.method, a.args]),
    [
      ['CPU', 'SetCpuLongPower', [55]],
      ['CPU', 'SetCpuShortPower', [75]],
      ['CPU', 'SetCPUTempWall', [95]],
      ['Power', 'SetCPUMaxFrequency', [4400]],
      ['Power', 'EnableTurbo', []],
    ],
  )
})

test('planBootActions：切到 Performance/Saving 档用对应数值与睿频开关', () => {
  const perf = only(planBootActions(baseConfig({App: {BootAdvancedCPUSystem: true}, Cpu: {CpuProfile: 'performance'}})))
  assert.equal(perf[0].args[0], 75)
  assert.equal(perf[1].args[0], 90)
  assert.equal(perf[4].method, 'EnableTurbo')

  const save = only(planBootActions(baseConfig({App: {BootAdvancedCPUSystem: true}, Cpu: {CpuProfile: 'saving'}})))
  assert.equal(save[0].args[0], 35)
  assert.equal(save[4].method, 'DisableTurbo', 'Saving 档 CpuTurbo=false 应关睿频')
})

test('planBootActions：未知档位回落到 Default', () => {
  const actions = only(planBootActions(baseConfig({App: {BootAdvancedCPUSystem: true}, Cpu: {CpuProfile: 'nonsense'}})))
  assert.equal(actions[0].args[0], 55)
  assert.ok(PROFILE_KEY.default)
})

test('planBootActions：全核 Curve Optimizer', () => {
  const actions = only(
    planBootActions(
      baseConfig({App: {BootSetRyzenSmuCurveOptimizerAll: true}, Smu: {CurveOptimizerAll: -30}}),
    ),
  )
  assert.deepEqual(actions.map((a) => [a.group, a.method, a.args]), [['RyzenSmu', 'SetCurveOptimizerAll', [-30]]])
})

test('planBootActions：分核模式只应用非零核心', () => {
  const per = new Array(16).fill(0)
  per[0] = -20
  per[3] = -35
  const actions = only(
    planBootActions(
      baseConfig({
        App: {BootSetRyzenSmuCurveOptimizerAll: true, BootSetRyzenSmuCurveOptimizerPerCore: true},
        Smu: {CurveOptimizerPerCore: per},
      }),
    ),
  )
  assert.deepEqual(
    actions.map((a) => a.args),
    [
      [0, -20],
      [3, -35],
    ],
  )
})

test('planBootActions：分核 CO 全 0 时记为跳过而非写入', () => {
  const actions = planBootActions(
    baseConfig({
      App: {BootSetRyzenSmuCurveOptimizerAll: true, BootSetRyzenSmuCurveOptimizerPerCore: true},
    }),
  )
  assert.deepEqual(only(actions), [])
  assert.match(skips(actions).join(), /全为 0/)
})

test('planBootActions：逐项勾选的 SMU 参数，0 值跳过', () => {
  const actions = planBootActions(
    baseConfig({
      Smu: {StapmLimit: 65, FastLimit: 0, BootApplyItems: ['StapmLimit', 'FastLimit', 'NotAKey']},
    }),
  )
  assert.deepEqual(only(actions).map((a) => [a.method, a.args]), [['SetStapmLimit', [65]]])
  const s = skips(actions).join('\n')
  assert.match(s, /FastLimit=0/)
  assert.match(s, /未知的 SMU 参数 NotAKey/)
})

test('planBootActions：GPU 自动应用明确标记跳过', () => {
  const actions = planBootActions(baseConfig({App: {BootAdvancedGPUSystem: true}}))
  assert.deepEqual(only(actions), [])
  assert.match(skips(actions).join(), /GPU/)
})


test('runBootActions：成功/失败/跳过分别汇总，失败不中断', async () => {
  const calls = []
  const res = await runBootActions(
    [
      {group: 'CPU', method: 'SetCpuLongPower', args: [55], label: '长时功耗'},
      {group: 'RyzenSmu', method: 'SetStapmLimit', args: [65], label: 'STAPM'},
      {group: 'Power', method: 'EnableTurbo', args: [], label: '睿频'},
      {skip: true, label: 'GPU 跳过'},
    ],
    async (group, method, args) => {
      calls.push([group, method, args])
      if (method === 'SetStapmLimit') return {Success: false, Message: 'smu 不可用'}
      return {Success: true}
    },
  )
  assert.deepEqual(res.applied, ['长时功耗', '睿频'])
  assert.equal(res.failed.length, 1)
  assert.match(res.failed[0], /STAPM.*smu 不可用/)
  assert.deepEqual(res.skipped, ['GPU 跳过'])
  assert.equal(calls.length, 3, '失败那条之后仍继续执行')
})

test('runBootActions：call 抛异常也记为失败', async () => {
  const res = await runBootActions([{group: 'CPU', method: 'X', args: [], label: 'X'}], async () => {
    throw new Error('EC 不可用')
  })
  assert.deepEqual(res.applied, [])
  assert.match(res.failed[0], /EC 不可用/)
})
