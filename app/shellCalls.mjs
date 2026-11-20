/**
 * 外壳侧实现的方法。
 *
 * 有几类调用不该进 daemon：daemon 是 root 且没有用户图形会话，凡是"以用户身份做的事"
 * （打开浏览器、控制系统音量、改 GNOME 设置）都必须由 Electron 主进程代劳。
 * 这里放这些方法的实现，做成纯函数以便脱离 Electron 单测。
 *
 * 约定：handleShellCall 返回 null 表示"不归外壳管"，调用方应继续转发给 daemon。
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

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

/**
 * 处理不经过 daemon 的调用。
 * @param {string} group  BridgeApi 分组名
 * @param {string} method BridgeApi 方法名
 * @param {unknown[]} args 前端传入的参数
 * @param {{openExternal?: (url: string) => Promise<unknown>}} deps 注入的 shell.openExternal
 * @returns {null | {Success: boolean, Message: string}}
 */
export async function handleShellCall(group, method, args, {openExternal} = {}) {
  if (group !== 'SystemInfo' || method !== 'OpenUrl') return null
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
