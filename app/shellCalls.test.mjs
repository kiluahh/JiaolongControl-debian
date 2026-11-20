import test from 'node:test'
import assert from 'node:assert/strict'

import {handleShellCall, normalizeUrl} from './shellCalls.mjs'

const PAWNIO = 'https://pawnio.eu/'

test('normalizeUrl：接受 http/https 并归一化', () => {
  assert.deepEqual(normalizeUrl(PAWNIO), {ok: true, url: 'https://pawnio.eu/'})
  assert.equal(normalizeUrl('  http://example.com/a  ').url, 'http://example.com/a')
})

test('normalizeUrl：拒绝非 http/https 与非法输入', () => {
  assert.equal(normalizeUrl('file:///etc/passwd').ok, false)
  assert.equal(normalizeUrl('javascript:alert(1)').ok, false)
  assert.equal(normalizeUrl('not a url').ok, false)
  assert.equal(normalizeUrl('').ok, false)
  assert.equal(normalizeUrl(undefined).ok, false)
})

test('handleShellCall：非外壳方法返回 null（交给 daemon）', async () => {
  const calls = []
  const openExternal = async (u) => calls.push(u)
  for (const [group, method] of [
    ['CPU', 'GetCpuUsage'],
    ['Osd', 'SetVolume'],
    ['SystemInfo', 'GetSystemOverview'],
  ]) {
    assert.equal(await handleShellCall(group, method, [], {openExternal}), null)
  }
  assert.deepEqual(calls, [], '非外壳方法不应触发 openExternal')
})

test('handleShellCall：OpenUrl 调 openExternal 并返回成功', async () => {
  const calls = []
  const res = await handleShellCall('SystemInfo', 'OpenUrl', [PAWNIO], {
    openExternal: async (u) => calls.push(u),
  })
  assert.equal(res.Success, true)
  assert.match(res.Message, /pawnio\.eu/)
  assert.deepEqual(calls, [PAWNIO])
})

test('handleShellCall：拒绝危险协议且不打开', async () => {
  const calls = []
  const openExternal = async (u) => calls.push(u)
  const res = await handleShellCall('SystemInfo', 'OpenUrl', ['file:///etc/passwd'], {openExternal})
  assert.equal(res.Success, false)
  assert.match(res.Message, /http/)
  assert.deepEqual(calls, [])
})

test('handleShellCall：openExternal 抛错时返回失败而非崩溃', async () => {
  const res = await handleShellCall('SystemInfo', 'OpenUrl', [PAWNIO], {
    openExternal: async () => {
      throw new Error('no browser')
    },
  })
  assert.equal(res.Success, false)
  assert.match(res.Message, /no browser/)
})

test('handleShellCall：缺少 openExternal 时给出明确失败信息', async () => {
  const res = await handleShellCall('SystemInfo', 'OpenUrl', [PAWNIO], {})
  assert.equal(res.Success, false)
  assert.match(res.Message, /openExternal/)
})
