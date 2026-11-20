import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {createPowerSampler, energyDelta, findPackageDomain, wattsBetween} from './rapl.mjs'

test('energyDelta：正常差值', () => {
  assert.equal(energyDelta(1000, 4000, 65532610987), 3000)
  assert.equal(energyDelta(1000, 1000, 65532610987), 0)
})

test('energyDelta：计数器回绕按量程修正', () => {
  const max = 1000
  // prev=900, cur=100 → 回绕后实际走了 (1000-900)+100 = 200
  assert.equal(energyDelta(900, 100, max), 200)
})

test('energyDelta：回绕但没有量程时返回 null，不猜', () => {
  assert.equal(energyDelta(900, 100, null), null)
  assert.equal(energyDelta(900, 100, 0), null)
})

test('energyDelta：非法输入返回 null', () => {
  assert.equal(energyDelta(null, 100, 1000), null)
  assert.equal(energyDelta(100, undefined, 1000), null)
  assert.equal(energyDelta(NaN, 100, 1000), null)
})

test('wattsBetween：1 秒 45J → 45W', () => {
  const w = wattsBetween({energy: 1_000_000, at: 0}, {energy: 46_000_000, at: 1000}, 65532610987)
  assert.equal(w, 45)
})

test('wattsBetween：0.5 秒 30J → 60W', () => {
  const w = wattsBetween({energy: 0, at: 0}, {energy: 30_000_000, at: 500}, 65532610987)
  assert.equal(w, 60)
})

test('wattsBetween：时间没前进返回 null', () => {
  assert.equal(wattsBetween({energy: 0, at: 1000}, {energy: 10_000_000, at: 1000}, 1000), null)
})

test('wattsBetween：回绕场景也算得出功率', () => {
  const max = 1_000_000
  // prev=600000 → 走完量程到 1000000（+400000），再从 0 走到 400000（+400000）
  const w = wattsBetween({energy: 600_000, at: 0}, {energy: 400_000, at: 1000}, max)
  // Δ = 800000 μJ = 0.8 J，1 秒 → 0.8W
  assert.equal(w, 0.8)
})

/** 在临时目录里造一个假的 powercap 树 */
function fakePowercap({pkgEnergy = 1000, maxRange = 65532610987} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-rapl-'))
  const pkg = path.join(root, 'intel-rapl:0')
  const core = path.join(root, 'intel-rapl:0:0')
  fs.mkdirSync(pkg)
  fs.mkdirSync(core)
  fs.writeFileSync(path.join(pkg, 'name'), 'package-0\n')
  fs.writeFileSync(path.join(pkg, 'energy_uj'), `${pkgEnergy}\n`)
  fs.writeFileSync(path.join(pkg, 'max_energy_range_uj'), `${maxRange}\n`)
  fs.writeFileSync(path.join(core, 'name'), 'core\n')
  fs.writeFileSync(path.join(core, 'energy_uj'), '500\n')
  return {root, pkg}
}

test('findPackageDomain：按 name 找 package-0，不误取 core 域', () => {
  const {root, pkg} = fakePowercap()
  assert.equal(findPackageDomain(root), pkg)
  fs.rmSync(root, {recursive: true, force: true})
})

test('findPackageDomain：目录不存在返回 null', () => {
  assert.equal(findPackageDomain('/nonexistent/powercap'), null)
})

test('createPowerSampler：第一次只建基线，第二次按时间差算瓦数', () => {
  const {root, pkg} = fakePowercap()
  let t = 0
  const sampler = createPowerSampler({root, now: () => t})
  assert.equal(sampler.available, true)
  assert.equal(sampler.sample(), null, '第一次没有基线')

  // 1 秒后能量 +45J → 45W
  fs.writeFileSync(path.join(pkg, 'energy_uj'), `${1000 + 45_000_000}\n`)
  t = 1000
  assert.equal(sampler.sample(), 45)

  // 再过 1 秒 +60J → 60W
  fs.writeFileSync(path.join(pkg, 'energy_uj'), `${1000 + 105_000_000}\n`)
  t = 2000
  assert.equal(sampler.sample(), 60)

  fs.rmSync(root, {recursive: true, force: true})
})

test('createPowerSampler：间隔太短时返回上一次结果', () => {
  const {root, pkg} = fakePowercap()
  let t = 0
  const sampler = createPowerSampler({root, now: () => t})
  sampler.sample()
  fs.writeFileSync(path.join(pkg, 'energy_uj'), `${1000 + 45_000_000}\n`)
  t = 1000
  assert.equal(sampler.sample(), 45)
  // 50ms 后读一次（不足 100ms）→ 返回上次的 45，而不是 0 或乱跳
  fs.writeFileSync(path.join(pkg, 'energy_uj'), `${1000 + 46_000_000}\n`)
  t = 1050
  assert.equal(sampler.sample(), 45)
  fs.rmSync(root, {recursive: true, force: true})
})

test('createPowerSampler：读不到 energy_uj（非 root）时 available 且返回 null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-rapl-'))
  const pkg = path.join(root, 'intel-rapl:0')
  fs.mkdirSync(pkg)
  fs.writeFileSync(path.join(pkg, 'name'), 'package-0\n')
  // 不建 energy_uj，模拟无权限
  const sampler = createPowerSampler({root})
  assert.equal(sampler.available, true)
  assert.equal(sampler.sample(), null)
  fs.rmSync(root, {recursive: true, force: true})
})
