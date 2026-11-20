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

const memo = new Map()

function invoke(group, method, args) {
  const key = `${group}.${method}:${JSON.stringify(args)}`
  if (memo.has(key)) return memo.get(key)
  const p = ipcRenderer.invoke('jlc:call', {group, method, args}).then(
    (res) => JSON.stringify(res ?? {Success: false, Message: '空响应'}),
    (e) => JSON.stringify({Success: false, Message: String(e?.message ?? e)}),
  )
  memo.set(key, p)
  setTimeout(() => memo.delete(key), 1000)
  return p
}

/** 返回带 toJson() 的 thenable，形状与 WebView2 hostObjects 一致 */
function makeCall(group, method) {
  return (...args) => {
    const json = () => invoke(group, method, args)
    const thenable = {
      toJson: json,
      then: (onFulfilled, onRejected) => json().then(onFulfilled, onRejected),
      catch: (onRejected) => json().catch(onRejected),
      finally: (fn) => json().finally(fn),
    }
    return thenable
  }
}

const bridgeTarget = {}
const bridgeProxy = new Proxy(bridgeTarget, {
  get(target, group) {
    if (typeof group !== 'string') return undefined
    if (!target[group]) {
      target[group] = new Proxy(
        {},
        {
          get(_t, method) {
            if (typeof method !== 'string') return undefined
            return makeCall(group, method)
          },
        },
      )
    }
    return target[group]
  },
})

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
