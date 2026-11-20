import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {cpuTempC, gpuTempAmd, hwmonTempC} from './sysfs.mjs'

/** 造一个临时 hwmon 树 */
function fakeHwmon(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-hwmon-'))
  entries.forEach(({index, name, milli}) => {
    const dir = path.join(root, `hwmon${index}`)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'name'), `${name}\n`)
    if (milli !== undefined) fs.writeFileSync(path.join(dir, 'temp1_input'), `${milli}\n`)
  })
  return root
}

test('hwmonTempC：按名称找到并换算成摄氏度', () => {
  const root = fakeHwmon([
    {index: 0, name: 'acpitz', milli: 40000},
    {index: 1, name: 'k10temp', milli: 63500},
  ])
  assert.equal(hwmonTempC('k10temp', root), 64)
  assert.equal(cpuTempC(root), 64)
  fs.rmSync(root, {recursive: true, force: true})
})

test('hwmonTempC：只认名称，不会拿第一个凑数', () => {
  const root = fakeHwmon([{index: 0, name: 'acpitz', milli: 40000}])
  assert.equal(hwmonTempC('k10temp', root), null)
  fs.rmSync(root, {recursive: true, force: true})
})

test('hwmonTempC：目录不存在或没有 temp1_input 时返回 null', () => {
  assert.equal(cpuTempC('/nonexistent/hwmon'), null)
  const root = fakeHwmon([{index: 0, name: 'k10temp'}])
  assert.equal(cpuTempC(root), null)
  fs.rmSync(root, {recursive: true, force: true})
})

test('gpuTempAmd：读 amdgpu 域', () => {
  const root = fakeHwmon([
    {index: 0, name: 'k10temp', milli: 60000},
    {index: 1, name: 'amdgpu', milli: 57500},
  ])
  assert.equal(gpuTempAmd(root), 58)
  fs.rmSync(root, {recursive: true, force: true})
})
