import {test} from 'node:test'
import assert from 'node:assert/strict'

import {
  FAN_DUTY_MAX,
  FAN_MAX_RPM,
  curveRpm,
  dutyToRpm,
  isLegacyPercentFan,
  isPercentCurve,
  migrateFanConfig,
  rpmToDuty,
} from './fan.mjs'

test('rpmToDuty：RPM 不再是"EC 档位"，3000 RPM 应该≈88/200 而不是 200', () => {
  assert.equal(rpmToDuty(0), 0)
  assert.equal(rpmToDuty(3000), 88)
  assert.equal(rpmToDuty(1500), 44)
  assert.equal(rpmToDuty(FAN_MAX_RPM), FAN_DUTY_MAX)
})

test('rpmToDuty：越界与脏数据钳位，不产生负占空比或 NaN', () => {
  assert.equal(rpmToDuty(99999), FAN_DUTY_MAX)
  assert.equal(rpmToDuty(-500), 0)
  assert.equal(rpmToDuty('abc'), 0)
  assert.equal(rpmToDuty(null), 0)
  assert.equal(rpmToDuty(undefined), 0)
})

test('dutyToRpm：回显换算', () => {
  assert.equal(dutyToRpm(0), 0)
  assert.equal(dutyToRpm(FAN_DUTY_MAX), FAN_MAX_RPM)
  assert.equal(dutyToRpm(150), 5100)
  assert.equal(dutyToRpm(999), FAN_MAX_RPM)
})

test('isPercentCurve：0..100 是百分比口径，1500+ 是 RPM', () => {
  assert.equal(isPercentCurve([{temp: 30, speed: 0}, {temp: 95, speed: 100}]), true)
  assert.equal(isPercentCurve([{temp: 60, speed: 1500}]), false)
  assert.equal(isPercentCurve([]), false)
  assert.equal(isPercentCurve(null), false)
})

test('isLegacyPercentFan：曲线是百分比、手动已是 RPM 的混合配置也要识别', () => {
  // 真实踩到的状态：前端只改过手动转速（RPM），曲线还是出厂百分比
  assert.equal(
    isLegacyPercentFan({
      ManualFanSpeed: 5500,
      CpuFanCurve: [{temp: 30, speed: 0}, {temp: 95, speed: 100}],
    }),
    true,
  )
  assert.equal(isLegacyPercentFan({ManualFanSpeed: 50}), true)
  assert.equal(isLegacyPercentFan({ManualFanSpeed: 5000, CpuFanCurve: [{temp: 60, speed: 1500}]}), false)
  assert.equal(isLegacyPercentFan(null), false)
})

test('migrateFanConfig：百分比曲线 → RPM，手动 RPM 保持不变', () => {
  const legacy = {
    FanCurveMerge: true,
    ManualFanSpeed: 5500,
    CpuFanCurve: [
      {temp: 30, speed: 0},
      {temp: 95, speed: 100},
    ],
    GpuFanCurve: [{temp: 95, speed: 25}],
  }
  const snapshot = JSON.stringify(legacy)
  const {fan, migrated} = migrateFanConfig(legacy)
  assert.equal(migrated, true)
  assert.equal(JSON.stringify(legacy), snapshot, '入参不能被改')
  assert.equal(fan.ManualFanSpeed, 5500, '已是 RPM 的手动转速不能被再换算')
  assert.deepEqual(fan.CpuFanCurve.map((p) => p.speed), [0, 6800])
  assert.deepEqual(fan.GpuFanCurve.map((p) => p.speed), [1700])
  assert.equal(fan.FanCurveMerge, true, '其它字段原样保留')
})

test('migrateFanConfig：手动百分比 + 曲线已是 RPM 的混合配置', () => {
  const {fan, migrated} = migrateFanConfig({ManualFanSpeed: 50, CpuFanCurve: [{temp: 60, speed: 1500}]})
  assert.equal(migrated, true)
  assert.equal(fan.ManualFanSpeed, 3400)
  assert.deepEqual(fan.CpuFanCurve.map((p) => p.speed), [1500], 'RPM 曲线不能被二次换算')
})

test('migrateFanConfig：全是 RPM 时原样返回（同一个对象引用）', () => {
  const rpm = {ManualFanSpeed: 3000, CpuFanCurve: [{temp: 60, speed: 1500}]}
  const out = migrateFanConfig(rpm)
  assert.equal(out.migrated, false)
  assert.equal(out.fan, rpm)
})

test('curveRpm：两端钳位 + 中间线性插值', () => {
  const curve = [
    {temp: 60, speed: 1500},
    {temp: 80, speed: 3000},
    {temp: 100, speed: 5800},
  ]
  assert.equal(curveRpm(curve, 40), 1500) // 低于第一点
  assert.equal(curveRpm(curve, 60), 1500)
  assert.equal(curveRpm(curve, 70), 2250) // 1500 + 0.5*(3000-1500)
  assert.equal(curveRpm(curve, 80), 3000)
  assert.equal(curveRpm(curve, 90), 4400) // 3000 + 0.5*(5800-3000)
  assert.equal(curveRpm(curve, 120), 5800) // 高于最后一点
})

test('curveRpm：乱序点、缺点、脏数据', () => {
  const shuffled = [
    {temp: 100, speed: 5800},
    {temp: 60, speed: 1500},
  ]
  assert.equal(curveRpm(shuffled, 80), 3650)
  assert.equal(curveRpm([], 70, 2200), 2200)
  assert.equal(curveRpm([{temp: 60}], 70, 0), 0)
  assert.equal(curveRpm(null, 70, 999), 999)
  assert.equal(curveRpm([{temp: 60, speed: 1500}], 'hot'), 1500)
})
