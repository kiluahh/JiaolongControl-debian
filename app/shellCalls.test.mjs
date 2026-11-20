import test from 'node:test'
import assert from 'node:assert/strict'

import {
  handleShellCall,
  normalizeUrl,
  parseWpctlVolume,
  touchpadLockedFromGsettings,
} from './shellCalls.mjs'

const PAWNIO = 'https://pawnio.eu/'
const TOUCHPAD = ['org.gnome.desktop.peripherals.touchpad', 'send-events']

/** 模拟 gsettings：记住当前值，get 返回带单引号的输出，set 写回 */
function fakeGsettings(initial = 'enabled') {
  const state = {value: initial, calls: []}
  const runGsettings = async (args) => {
    state.calls.push(args)
    if (args[0] === 'get') return {ok: true, stdout: `'${state.value}'\n`}
    if (args[0] === 'set') {
      state.value = args[3]
      return {ok: true, stdout: ''}
    }
    return {ok: false, stderr: `不支持的 gsettings 子命令: ${args[0]}`}
  }
  return {state, runGsettings}
}

const daemonLocks = {
  Success: true,
  Message: 'CapsLock/NumLock 来自键盘 LED',
  Data: {CapsLock: true, NumLock: false, FnLock: null, TouchpadLock: null},
}

// ── OpenUrl ─────────────────────────────────────────────────────────────────
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
    ['Osd', 'ShowTest'],
    ['Osd', 'SetCapsLock'],
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

// ── 触摸板锁 ────────────────────────────────────────────────────────────────
test('touchpadLockedFromGsettings：解析三种取值', () => {
  assert.equal(touchpadLockedFromGsettings("'enabled'\n"), false)
  assert.equal(touchpadLockedFromGsettings("'disabled'\n"), true)
  assert.equal(touchpadLockedFromGsettings("'disabled-on-external-mouse'"), true)
  assert.equal(touchpadLockedFromGsettings(''), null)
  assert.equal(touchpadLockedFromGsettings(undefined), null)
})

test('GetLockStates：合并 daemon 的 LED 状态与 GNOME 触摸板开关', async () => {
  const {state, runGsettings} = fakeGsettings('disabled')
  const res = await handleShellCall('Osd', 'GetLockStates', [], {
    callDaemon: async (g, m, a) => {
      assert.equal(g, 'Osd')
      assert.equal(m, 'GetLockStates')
      assert.deepEqual(a, [])
      return daemonLocks
    },
    runGsettings,
  })
  assert.equal(res.Success, true)
  assert.equal(res.Data.CapsLock, true, 'LED 真值必须原样带过来')
  assert.equal(res.Data.NumLock, false)
  assert.equal(res.Data.FnLock, null)
  assert.equal(res.Data.TouchpadLock, true, 'gsettings disabled → 已锁定')
  assert.deepEqual(state.calls, [['get', ...TOUCHPAD]])
})

test('GetLockStates：gsettings 不可用时触摸板为未知，不影响其它项', async () => {
  const res = await handleShellCall('Osd', 'GetLockStates', [], {
    callDaemon: async () => daemonLocks,
    runGsettings: async () => ({ok: false, stderr: 'No such schema “org.gnome.desktop.peripherals.touchpad”'}),
  })
  assert.equal(res.Success, true)
  assert.equal(res.Data.TouchpadLock, null)
  assert.equal(res.Data.CapsLock, true)
})

test('GetLockStates：daemon 不可用时仍返回触摸板状态', async () => {
  const {runGsettings} = fakeGsettings('enabled')
  const res = await handleShellCall('Osd', 'GetLockStates', [], {
    callDaemon: async () => {
      throw new Error('jlc-daemon 未运行')
    },
    runGsettings,
  })
  assert.equal(res.Success, true)
  assert.equal(res.Data.CapsLock, null)
  assert.equal(res.Data.TouchpadLock, false)
})

test('SetTouchpadLock(true)：写 disabled、回读确认、并推送 lock-states-changed', async () => {
  const {state, runGsettings} = fakeGsettings('enabled')
  const events = []
  const res = await handleShellCall('Osd', 'SetTouchpadLock', [true], {
    runGsettings,
    emit: (payload) => events.push(payload),
  })
  assert.equal(res.Success, true)
  assert.match(res.Message, /禁用/)
  assert.equal(state.value, 'disabled')
  assert.deepEqual(events, [{type: 'lock-states-changed', TouchpadLock: true}])
})

test('SetTouchpadLock(false)：从 disabled 恢复 enabled', async () => {
  const {state, runGsettings} = fakeGsettings('disabled')
  const res = await handleShellCall('Osd', 'SetTouchpadLock', [false], {runGsettings})
  assert.equal(res.Success, true)
  assert.match(res.Message, /启用/)
  assert.equal(state.value, 'enabled')
})

test('SetTouchpadLock：写入失败时返回 gsettings 的错误信息', async () => {
  const res = await handleShellCall('Osd', 'SetTouchpadLock', [true], {
    runGsettings: async () => ({ok: false, stderr: 'dconf 只读'}),
  })
  assert.equal(res.Success, false)
  assert.match(res.Message, /dconf 只读/)
})

test('SetTouchpadLock：写入后回读不一致要报失败，不能假装成功', async () => {
  // set 命令退出码 0，但值没变（例如被 gsd 覆盖）
  const runGsettings = async (args) => {
    if (args[0] === 'get') return {ok: true, stdout: "'enabled'"}
    return {ok: true, stdout: ''}
  }
  const events = []
  const res = await handleShellCall('Osd', 'SetTouchpadLock', [true], {
    runGsettings,
    emit: (payload) => events.push(payload),
  })
  assert.equal(res.Success, false)
  assert.match(res.Message, /回读不一致/)
  assert.deepEqual(events, [], '失败时不应推送状态')
})

// ── 系统音量（wpctl） ───────────────────────────────────────────────────────
const SINK = '@DEFAULT_AUDIO_SINK@'

/** 模拟 wpctl：记住音量/静音状态，输出格式与真 wpctl 一致 */
function fakeWpctl({volume = 0.7, muted = false} = {}) {
  const state = {volume, muted, calls: []}
  const runWpctl = async (args) => {
    state.calls.push(args)
    if (args[0] === 'get-volume') {
      return {ok: true, stdout: `Volume: ${state.volume.toFixed(2)}${state.muted ? ' [MUTED]' : ''}\n`}
    }
    if (args[0] === 'set-volume') {
      state.volume = Number(String(args[2]).replace('%', '')) / 100
      return {ok: true, stdout: ''}
    }
    if (args[0] === 'set-mute') {
      state.muted = args[2] === '1'
      return {ok: true, stdout: ''}
    }
    return {ok: false, stderr: `未知子命令 ${args[0]}`}
  }
  return {state, runWpctl}
}

test('parseWpctlVolume：解析音量与静音标记', () => {
  assert.deepEqual(parseWpctlVolume('Volume: 0.70\n'), {Volume: 70, Muted: false})
  assert.deepEqual(parseWpctlVolume('Volume: 1.00'), {Volume: 100, Muted: false})
  assert.deepEqual(parseWpctlVolume('Volume: 0.00 [MUTED]\n'), {Volume: 0, Muted: true})
  assert.equal(parseWpctlVolume(''), null)
  assert.equal(parseWpctlVolume(undefined), null)
  assert.equal(parseWpctlVolume('没有音量字段'), null)
})

test('GetVolume：返回系统真实音量', async () => {
  const {runWpctl, state} = fakeWpctl({volume: 0.42, muted: true})
  const res = await handleShellCall('Osd', 'GetVolume', [], {runWpctl})
  assert.equal(res.Success, true)
  assert.deepEqual(res.Data, {Volume: 42, Muted: true})
  assert.deepEqual(state.calls, [['get-volume', SINK]])
})

test('GetVolume：wpctl 不可用时明确报错，不返回假 0', async () => {
  const res = await handleShellCall('Osd', 'GetVolume', [], {
    runWpctl: async () => ({ok: false, stderr: 'command not found: wpctl'}),
  })
  assert.equal(res.Success, false)
  assert.match(res.Message, /wpctl/)
  assert.equal(res.Data, undefined)
})

test('SetVolume：写系统音量并回读确认', async () => {
  const {state, runWpctl} = fakeWpctl({volume: 0.7})
  const res = await handleShellCall('Osd', 'SetVolume', [35], {runWpctl})
  assert.equal(res.Success, true)
  assert.equal(state.volume, 0.35)
  assert.deepEqual(state.calls.at(-1), ['get-volume', SINK])
  assert.match(res.Message, /35%/)
})

test('SetVolume：越界值夹到 0..100', async () => {
  const {state, runWpctl} = fakeWpctl({volume: 0.5})
  const res = await handleShellCall('Osd', 'SetVolume', [150], {runWpctl})
  assert.equal(res.Success, true)
  assert.equal(state.volume, 1)
  assert.equal((await handleShellCall('Osd', 'SetVolume', [-20], {runWpctl})).Success, true)
  assert.equal(state.volume, 0)
})

test('SetVolume：回读不一致要报失败，不能假装成功', async () => {
  // set-volume 退出码 0，但值没变
  const runWpctl = async (args) =>
    args[0] === 'get-volume' ? {ok: true, stdout: 'Volume: 0.70'} : {ok: true, stdout: ''}
  const res = await handleShellCall('Osd', 'SetVolume', [35], {runWpctl})
  assert.equal(res.Success, false)
  assert.match(res.Message, /回读不一致/)
})

test('SetMute：静音与取消静音都回读确认', async () => {
  const {state, runWpctl} = fakeWpctl({volume: 0.5, muted: false})
  const on = await handleShellCall('Osd', 'SetMute', [true], {runWpctl})
  assert.equal(on.Success, true)
  assert.equal(state.muted, true)
  assert.match(on.Message, /已静音/)

  const off = await handleShellCall('Osd', 'SetMute', [false], {runWpctl})
  assert.equal(off.Success, true)
  assert.equal(state.muted, false)
})

test('SetMute：回读不一致要报失败', async () => {
  const runWpctl = async (args) =>
    args[0] === 'get-volume' ? {ok: true, stdout: 'Volume: 0.50'} : {ok: true, stdout: ''}
  const res = await handleShellCall('Osd', 'SetMute', [true], {runWpctl})
  assert.equal(res.Success, false)
  assert.match(res.Message, /回读不一致/)
})
