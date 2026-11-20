/**
 * WebView2 兼容层：让未修改的 Vue 前端跑在 Electron 里。
 *
 * 前端只用到三样东西：
 *   window.chrome.webview.hostObjects.bridge.<Group>.<Method>(...).toJson()
 *   window.chrome.webview.postMessage('window-minimize' | ...)
 *   window.chrome.webview.addEventListener / removeEventListener
 *
 * 因为 contextIsolation 关闭、nodeIntegration 关闭，这里可以直接改写 window。
 */
const {ipcRenderer} = require('electron')
const {createBridge} = require('./shim.cjs')

const memo = new Map()

/**
 * 这些方法不能命中 1s 去重缓存：它们的用途是"读回刚写入的状态"，
 * 命中缓存会拿到旧值，表现为音量滑条回弹、键盘开关状态与实际相反。
 */
const NO_MEMO = new Set([
  'Osd.GetVolume',
  'Osd.GetLockStates',
  'Keyboard.GetColor',
  'Keyboard.GetLightBrightness',
  'KeyboardGradient.IsRunning',
])

function invoke(group, method, args) {
  const name = `${group}.${method}`
  const key = `${name}:${JSON.stringify(args)}`
  if (NO_MEMO.has(name)) return runInvoke(name, key, group, method, args)
  if (memo.has(key)) return memo.get(key)
  const p = runInvoke(name, key, group, method, args)
  memo.set(key, p)
  setTimeout(() => memo.delete(key), 1000) // 与前端 1s 缓存语义一致
  return p
}

function runInvoke(name, key, group, method, args) {
  return ipcRenderer.invoke('jlc:call', {group, method, args}).then(
    (res) => JSON.stringify(res ?? {Success: false, Message: '空响应'}),
    (e) => JSON.stringify({Success: false, Message: String(e?.message ?? e)}),
  )
}

const bridgeProxy = createBridge(invoke)

const listeners = new Map()

const webview = {
  hostObjects: {bridge: bridgeProxy},
  postMessage(message) {
    if (typeof message === 'string') ipcRenderer.send('jlc:window', message)
  },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    listeners.get(type)?.delete(fn)
  },
}

window.chrome = window.chrome || {}
window.chrome.webview = webview

ipcRenderer.on('jlc:event', (_e, {type, detail}) => {
  for (const fn of listeners.get(type) ?? []) {
    try {
      fn({data: detail})
    } catch {}
  }
})

// 无边框窗口：用原生 app-region 实现拖动（Wayland 下无法程序化移动窗口）
window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style')
  style.textContent = `
    .drag-region, .title-bar { -webkit-app-region: drag; }
    .window-actions, .action-btn, button, input, select, textarea, a { -webkit-app-region: no-drag; }
    html, body { overscroll-behavior: none; }
  `
  document.head.appendChild(style)
})
