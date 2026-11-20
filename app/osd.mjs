/**
 * OSD 悬浮指示器（Linux 外壳实现）。
 *
 * 实测约束（2026-11-20，GNOME 48 Wayland + XWayland）：
 *   1. 拿不到全局按键钩子（Wayland 不允许），只能轮询状态变化；
 *   2. GNOME 自己的音量条没有 API 可关，所以只做系统不提示的四类：
 *      性能模式 / 风扇 / 键盘背光 / 触摸板；
 *   3. 透明置顶窗必须是 XWayland 窗口（本程序本来就跑在 XWayland 下），
 *      已实测可盖在普通窗口之上，且点击穿透、不进任务栏。
 */
import {BrowserWindow, screen} from 'electron'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  diffOsdState,
  normalizeOsdConfig,
  osdPayload,
  osdPlacement,
  osdSlideDirection,
  osdWindowSize,
} from './osd-core.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OSD_HTML = path.join(__dirname, 'osd.html')

/** kind → config 里的开关字段 */
const KIND_FLAG = {
  perf: 'showPerformanceMode',
  fan: 'showFan',
  keyboard: 'showKeyboardBacklight',
  touchpad: 'showTouchpad',
}

/** 「效果预览」按钮没传值时用的示例值 */
const TEST_SAMPLE = {perf: 1, fan: true, keyboard: 3, touchpad: true}

const toNumber = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {{
 *   callDaemon?: (group: string, method: string, args?: unknown[]) => Promise<any>,
 *   runGsettings?: (args: string[]) => Promise<{ok: boolean, stdout?: string, stderr?: string}>,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createOsd({callDaemon, runGsettings, log = () => {}} = {}) {
  let win = null
  let cfg = normalizeOsdConfig({})
  let cfgAt = 0
  let prev = null
  let running = false
  let loopTimer = null
  let hideTimer = null
  let fadeTimer = null
  let queue = []
  let showing = false
  let inflight = false
  let syncing = null

  async function refreshConfig(force = false) {
    if (!force && Date.now() - cfgAt < 1500) return cfg
    cfgAt = Date.now()
    try {
      const res = await callDaemon?.('ConfigCtrl', 'GetConfig')
      if (res?.Success && res.Data?.Osd) cfg = normalizeOsdConfig(res.Data.Osd)
    } catch (e) {
      log(`OSD 读取配置失败：${e?.message ?? e}`)
    }
    return cfg
  }

  /** 一次采样：三路 EC/vendor 读取 + 一路 gsettings；任一路失败记 null，不参与比较 */
  async function snapshot() {
    const read = async (group, method) => {
      try {
        const res = await callDaemon?.(group, method)
        return res?.Success ? res.Data : null
      } catch {
        return null
      }
    }
    const [perf, fan, kbd] = await Promise.all([
      read('PerformanceMode', 'Get'),
      read('Fan', 'GetMaxFanSpeedSwitch'),
      read('Keyboard', 'GetLightBrightness'),
    ])
    let touchpad = null
    try {
      const g = await runGsettings?.(['get', 'org.gnome.desktop.peripherals.touchpad', 'send-events'])
      if (g?.ok) touchpad = !/disabled/.test(String(g.stdout ?? ''))
    } catch {
      touchpad = null
    }
    return {
      perf: toNumber(perf),
      fan: fan === null || fan === undefined ? null : !!fan,
      keyboard: toNumber(kbd),
      touchpad,
    }
  }

  async function tick() {
    if (inflight) return
    inflight = true
    try {
      await refreshConfig()
      if (!cfg.enabled) {
        prev = null
        return
      }
      const next = await snapshot()
      const changes = diffOsdState(prev, next)
      prev = next
      for (const c of changes) {
        if (cfg[KIND_FLAG[c.kind]]) enqueue(c.kind, c.value)
      }
    } finally {
      inflight = false
    }
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win
    const size = osdWindowSize(cfg.scale)
    win = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      type: 'toolbar',
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})
    win.setIgnoreMouseEvents(true, {forward: true})
    win.loadFile(OSD_HTML)
    win.on('closed', () => {
      win = null
    })
    return win
  }

  function render(w, payload) {
    const js = `window.__osdRender && window.__osdRender(${JSON.stringify(payload)})`
    const run = () =>
      w.webContents.executeJavaScript(js, true).catch((e) => log(`OSD 渲染失败：${e?.message ?? e}`))
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', run)
    else run()
  }

  function present(kind, value) {
    const size = osdWindowSize(cfg.scale)
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const pos = osdPlacement({
      position: cfg.position,
      customX: cfg.customX,
      customY: cfg.customY,
      width: size.width,
      height: size.height,
      workArea: display.workArea,
    })
    const w = ensureWindow()
    w.setBounds({x: pos.x, y: pos.y, width: size.width, height: size.height})
    const payload = osdPayload(kind, value, {
      durationMs: cfg.durationMs,
      animationMs: cfg.animationMs,
      opacity: cfg.opacity,
      slide: osdSlideDirection(cfg.position, cfg.customX),
    })
    render(w, payload)
    w.setAlwaysOnTop(true, 'screen-saver')
    if (w.isVisible()) w.moveTop?.()
    else w.showInactive()

    showing = true
    clearTimeout(fadeTimer)
    clearTimeout(hideTimer)
    fadeTimer = setTimeout(() => {
      if (!w.isDestroyed()) {
        w.webContents.executeJavaScript('window.__osdHide && window.__osdHide()').catch(() => {})
      }
    }, payload.durationMs)
    hideTimer = setTimeout(() => {
      showing = false
      if (!w.isDestroyed()) w.hide()
      const next = queue.shift()
      if (next) present(next.kind, next.value)
    }, payload.durationMs + payload.animationMs + 90)
  }

  function enqueue(kind, value) {
    if (showing) queue.push({kind, value})
    else present(kind, value)
  }

  /** 面板自己改了状态时立刻采样一次，别等下一个轮询周期 */
  function syncNow() {
    if (!cfg.enabled) return Promise.resolve()
    if (syncing) return syncing
    syncing = (async () => {
      try {
        await refreshConfig(true)
        await tick()
      } catch (e) {
        log(`OSD 同步失败：${e?.message ?? e}`)
      } finally {
        syncing = null
      }
    })()
    return syncing
  }

  function schedule() {
    clearTimeout(loopTimer)
    if (!running) return
    loopTimer = setTimeout(async () => {
      try {
        await tick()
      } catch (e) {
        log(`OSD 轮询失败：${e?.message ?? e}`)
      }
      schedule()
    }, cfg.pollIntervalMs)
  }

  async function start() {
    if (running) return
    running = true
    await refreshConfig(true)
    await tick()
    schedule()
  }

  function stop() {
    running = false
    clearTimeout(loopTimer)
    clearTimeout(hideTimer)
    clearTimeout(fadeTimer)
    loopTimer = hideTimer = fadeTimer = null
    queue = []
    showing = false
    if (win && !win.isDestroyed()) win.hide()
  }

  function destroy() {
    stop()
    prev = null
    if (win && !win.isDestroyed()) win.destroy()
    win = null
  }

  /** 设置页「效果预览」：不管 Enabled 开关，直接显示一次 */
  function showTest(kind, value) {
    if (!KIND_FLAG[kind]) return false
    const v = value === undefined || value === null ? TEST_SAMPLE[kind] : value
    queue = []
    refreshConfig().then(() => present(kind, v))
    return true
  }

  return {start, stop, destroy, syncNow, showTest, get config() { return cfg }}
}
