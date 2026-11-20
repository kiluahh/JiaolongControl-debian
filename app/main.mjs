/** JiaoLongControl Debian 外壳（Electron） */
import {app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, Notification} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {callDaemon, pingDaemon} from './bridge.mjs'
import {handleShellCall, runGsettings} from './shellCalls.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEV_URL = process.env.JLC_DEV_URL || null
const SMOKE = process.env.JLC_SMOKE === '1'
const ICON = path.join(ROOT, 'client', 'src', 'assets', 'icon', 'icon.png')

let win = null
let tray = null

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#0b0d10',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (DEV_URL) {
    win.loadURL(DEV_URL)
  } else {
    const index = path.join(ROOT, 'client', 'dist', 'index.html')
    if (!fs.existsSync(index)) {
      win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<body style="background:#111;color:#eee;font:14px system-ui;padding:40px">
             <h2>前端未构建</h2><p>请先运行：<code>cd client &amp;&amp; npx vite build</code></p></body>`,
          ),
      )
    } else {
      win.loadFile(index)
    }
  }

  win.once('ready-to-show', () => {
    if (!SMOKE) win.show()
  })

  if (process.env.JLC_DEBUG === '1') win.webContents.openDevTools({mode: 'detach'})

  // F12 打开调试器，Ctrl+Shift+I 同理（无边框窗口没有菜单栏）
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools()
    }
  })
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

function buildTray() {
  try {
    const img = nativeImage.createFromPath(ICON)
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({width: 22, height: 22}))
    tray.setToolTip('JiaoLongControl')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {label: '显示主界面', click: () => win?.show()},
        {type: 'separator'},
        {
          label: '退出',
          click: () => {
            app.isQuitting = true
            app.quit()
          },
        },
      ]),
    )
    tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()))
  } catch (e) {
    console.error('托盘创建失败（GNOME 需要 AppIndicator 扩展）:', e.message)
  }
}

/** 把事件推给渲染进程：preload 以 WebView2 message 的形式派发，App.vue 监听 'message' */
function emitToRenderer(payload) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('jlc:event', {type: 'message', detail: payload})
}

ipcMain.handle('jlc:call', async (_e, {group, method, args}) => {
  // 先看是否该由外壳以用户身份处理（打开链接、GNOME 触摸板设置…），否则转发给 root daemon
  const local = await handleShellCall(group, method, args, {
    openExternal: (url) => shell.openExternal(url),
    callDaemon,
    runGsettings,
    emit: emitToRenderer,
  })
  if (local) return local
  const res = await callDaemon(group, method, args)
  return res
})

ipcMain.on('jlc:window', (e, message) => {
  if (!win) return
  switch (message) {
    case 'window-minimize':
      win.minimize()
      break
    case 'window-maximize':
      win.isMaximized() ? win.unmaximize() : win.maximize()
      break
    case 'window-close':
      win.hide()
      break
    case 'window-drag':
      // Wayland 不允许应用移动自身窗口，拖动由 preload 注入的 app-region 完成
      break
  }
})

app.whenReady().then(async () => {
  createWindow()
  if (!SMOKE) buildTray()

  if (SMOKE) {
    // 自检：加载前端 → 走 preload shim → IPC → daemon，验证整条链路
    win.webContents.on('did-finish-load', async () => {
      try {
        const js = await win.webContents.executeJavaScript(`(async () => {
          const b = window.chrome.webview.hostObjects.bridge
          const cpu = JSON.parse(await b.CPU.GetCpuInfo().toJson())
          const fan = JSON.parse(await b.Fan.GetFanSpeed().toJson())
          return JSON.stringify({cpu, fan})
        })()`)
        console.log('SMOKE_JS', js)
        const caps = await callDaemon('Sys', 'Capabilities')
        console.log('SMOKE_DAEMON', JSON.stringify(caps))
        console.log('SMOKE_OK')
      } catch (e) {
        console.log('SMOKE_FAIL', e?.message ?? e)
      } finally {
        app.isQuitting = true
        app.exit(0)
      }
    })
  }

  const ping = await pingDaemon()
  if (!ping.Success) {
    console.warn(ping.Message)
    if (Notification.isSupported()) {
      new Notification({
        title: 'JiaoLongControl',
        body: `${ping.Message}\n硬件控制不可用，仅显示监控数据。`,
      }).show()
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 常驻托盘：不退出
})
