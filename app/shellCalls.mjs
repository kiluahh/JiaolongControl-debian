/**
 * 外壳侧实现的方法。
 *
 * 有几类调用不该进 daemon：daemon 是 root 且没有用户图形会话，凡是"以用户身份做的事"
 * （打开浏览器、控制系统音量、读写 GNOME 设置）都必须由 Electron 主进程代劳。
 * 这里放这些方法的实现，做成纯函数（依赖全部注入）以便脱离 Electron 单测。
 *
 * 约定：handleShellCall 返回 null 表示"不归外壳管"，调用方应继续转发给 daemon。
 */
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** GNOME 触摸板开关：send-events = enabled | disabled | disabled-on-external-mouse */
const TOUCHPAD_SCHEMA = 'org.gnome.desktop.peripherals.touchpad'
const TOUCHPAD_KEY = 'send-events'

/** 校验并归一化 URL，只放行 http/https（避免 file:// / javascript: 之类的越权打开） */
export function normalizeUrl(raw) {
  const url = String(raw ?? '').trim()
  if (!url) return {ok: false, message: '链接为空'}
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return {ok: false, message: `不是合法链接: ${url}`}
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {ok: false, message: `只允许打开 http/https 链接（收到 ${parsed.protocol}）`}
  }
  return {ok: true, url: parsed.href}
}

/** 默认的 gsettings 执行器：以当前用户身份调用（外壳跑在用户会话里） */
export async function runGsettings(args) {
  try {
    const {stdout, stderr} = await execFileAsync('gsettings', args, {timeout: 2000})
    return {ok: true, stdout, stderr}
  } catch (e) {
    return {ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? String(e)}
  }
}

/** 解析 `gsettings get` 的输出（'enabled' 带单引号）→ 锁定状态 true/false，读不到返回 null */
export function touchpadLockedFromGsettings(stdout) {
  const v = String(stdout ?? '')
    .trim()
    .replace(/^'|'$/g, '')
  if (!v) return null
  return v.startsWith('disabled')
}

async function readTouchpadLocked({runGsettings: run}) {
  if (typeof run !== 'function') return null
  const res = await run(['get', TOUCHPAD_SCHEMA, TOUCHPAD_KEY])
  if (!res?.ok) return null
  return touchpadLockedFromGsettings(res.stdout)
}

async function openUrl(args, {openExternal}) {
  if (typeof openExternal !== 'function') {
    return {Success: false, Message: '外壳未提供 openExternal，无法打开链接'}
  }
  const target = normalizeUrl(args?.[0])
  if (!target.ok) return {Success: false, Message: target.message}
  try {
    await openExternal(target.url)
    return {Success: true, Message: `已在浏览器打开 ${target.url}`}
  } catch (e) {
    return {Success: false, Message: `打开链接失败: ${e?.message ?? e}`}
  }
}

/**
 * 四项锁定状态：CapsLock/NumLock 由 daemon 读键盘 LED 得出，
 * TouchpadLock 只有当前会话能读（root daemon 拿不到用户的 dconf），
 * 所以这条调用改由外壳合并两个来源。
 */
async function getLockStates({callDaemon, runGsettings: run}) {
  let base = null
  if (typeof callDaemon === 'function') {
    try {
      base = await callDaemon('Osd', 'GetLockStates', [])
    } catch {
      base = null
    }
  }
  const baseData = base?.Data ?? {CapsLock: null, NumLock: null, FnLock: null}
  const touchpad = await readTouchpadLocked({runGsettings: run})
  const sources = ['CapsLock/NumLock 来自键盘 LED', 'TouchpadLock 来自 GNOME 设置']
  return {
    Success: true,
    Message: sources.join('；'),
    Data: {...baseData, TouchpadLock: touchpad},
  }
}

async function setTouchpadLock(args, {runGsettings: run, emit}) {
  if (typeof run !== 'function') {
    return {Success: false, Message: '外壳未提供 gsettings 执行器'}
  }
  const want = Boolean(args?.[0])
  const value = want ? 'disabled' : 'enabled'
  const res = await run(['set', TOUCHPAD_SCHEMA, TOUCHPAD_KEY, value])
  if (!res?.ok) {
    return {Success: false, Message: `写入触摸板设置失败: ${String(res?.stderr ?? '未知错误').trim()}`}
  }
  // 回读校验：dconf 写入可能被 GNOME 设置面板或 gsd 覆盖，不能只看命令退出码
  const now = await readTouchpadLocked({runGsettings: run})
  if (now !== want) {
    return {Success: false, Message: `写入后回读不一致（期望 ${want}，实际 ${now}）`}
  }
  // 前端 App.vue 监听 lock-states-changed → 更新 locks store，否则按钮要重进页面才刷新
  emit?.({type: 'lock-states-changed', TouchpadLock: now})
  return {Success: true, Message: want ? '触摸板已禁用' : '触摸板已启用'}
}

/**
 * 处理不经过 daemon 的调用。
 * @param {string} group  BridgeApi 分组名
 * @param {string} method BridgeApi 方法名
 * @param {unknown[]} args 前端传入的参数
 * @param {{
 *   openExternal?: (url: string) => Promise<unknown>,
 *   callDaemon?: (group: string, method: string, args?: unknown[]) => Promise<any>,
 *   runGsettings?: (args: string[]) => Promise<{ok: boolean, stdout?: string, stderr?: string}>,
 *   emit?: (payload: {type: string} & Record<string, unknown>) => void,
 * }} deps
 * @returns {null | {Success: boolean, Message: string, Data?: unknown}}
 */
export async function handleShellCall(group, method, args, deps = {}) {
  if (group === 'SystemInfo' && method === 'OpenUrl') return openUrl(args, deps)
  if (group === 'Osd' && method === 'GetLockStates') return getLockStates(deps)
  if (group === 'Osd' && method === 'SetTouchpadLock') return setTouchpadLock(args, deps)
  return null
}
