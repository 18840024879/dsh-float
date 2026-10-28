'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function fail(message) {
  try {
    process.stderr.write(`[dsh-float-helper] ${message}\n`)
  } catch {
    /* nothing left to report to */
  }
  process.exit(1)
}

let electron
try {
  electron = require('electron')
} catch {
  electron = null
}
if (!electron || typeof electron !== 'object' || !electron.app) {
  fail('must run under the Electron runtime (not node)')
}

const { app, globalShortcut, ipcMain, Menu, Tray, nativeImage, shell } = electron

const { Bridge } = require('./bridge')
const { captureRegion, prepareOverlay, prewarmCapture, stopPrewarmSoon } = require('./capture')
const { startPetWatch } = require('./pet-watch')
const { createFloatWindow } = require('./window')

const MOCK = process.argv.includes('--mock')
const SELFTEST = process.argv.includes('--selftest')
const HOST_PID = Number(process.env.DSH_FLOAT_HOST_PID || 0)
const EPOCH = Number(process.env.DSH_FLOAT_EPOCH || 0)
const PLUGIN_ROOT = process.env.DSH_FLOAT_PLUGIN_ROOT || path.resolve(__dirname, '..', '..')
const PREFERRED_HOTKEY = process.env.DSH_FLOAT_HOTKEY || 'Alt+Space'
const FALLBACK_HOTKEY = 'Ctrl+Alt+Space'

const UI_DIR = path.join(PLUGIN_ROOT, 'runtime', 'ui')
const UI_HTML = path.join(UI_DIR, 'index.html')
const OVERLAY_HTML = path.join(UI_DIR, 'overlay.html')
const OVERLAY_PRELOAD = path.join(__dirname, 'overlay-preload.js')
const PRELOAD = path.join(__dirname, 'preload.js')
const ICON_FILE = path.join(PLUGIN_ROOT, 'assets', 'icon.png')

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') app.exit(0)
  })
}

app.setName('dsh-float-helper')
const DATA_ROOT = path.join(os.homedir(), '.dsh', 'dsh-float')
app.setPath('userData', path.join(DATA_ROOT, MOCK ? 'helper-mock' : 'helper'))

if (!app.requestSingleInstanceLock()) {
  fail('another helper instance is already running')
}

const bridge = new Bridge({ epoch: EPOCH, mock: MOCK })
let float = null
let petWatch = null
let tray = null
let hotkey = PREFERRED_HOTKEY
let capturing = false
let quitting = false

function toast(message) {
  if (float) float.updateHotkeyNotice(message)
  process.stderr.write(`[dsh-float-helper] ${message}\n`)
}

function toggleWindow() {
  if (!float) return
  float.toggle()
}

function registerHotkey(preferred) {
  const tryKey = (key) => {
    try {
      return app.isReady() && globalShortcut.register(key, toggleWindow)
    } catch {
      return false
    }
  }
  if (preferred && tryKey(preferred)) return preferred
  if (tryKey(FALLBACK_HOTKEY)) return FALLBACK_HOTKEY
  return null
}

function buildTrayIcon() {
  try {
    const image = nativeImage.createFromPath(ICON_FILE)
    if (!image.isEmpty()) return image
  } catch {
    /* fall through */
  }
  return nativeImage.createEmpty()
}

function buildTray() {
  try {
    tray = new Tray(buildTrayIcon())
  } catch (error) {
    process.stderr.write(`[dsh-float-helper] tray unavailable: ${error.message}\n`)
    return
  }
  tray.setToolTip('DeepSeek 悬浮助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: toggleWindow },
      { label: '截图提问', click: () => void startCapture() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  )
  tray.on('click', toggleWindow)
}

async function startCapture() {
  if (capturing) return
  if (!float) return
  capturing = true
  try {
    const file = await captureRegion({
      floatWindow: float.win,
      overlayPreload: OVERLAY_PRELOAD,
      overlayHtml: OVERLAY_HTML,
    })
    if (!file) return
    const dataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
    float.show()
    if (!float.win.isDestroyed()) {
      float.win.webContents.send('float:event', { type: 'shot', path: file, dataUrl })
    }
  } catch (error) {
    toast(`截图失败：${error.message}`)
    float.show()
  } finally {
    capturing = false
  }
}

function wireIpc() {
  ipcMain.handle('float:request', async (_event, payload) => {
    const method = String(payload?.method || '')
    try {
      const data = await bridge.request(method, payload?.params || {})
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: { code: error?.code || 'REQUEST_FAILED', message: error?.message || String(error) } }
    }
  })

  ipcMain.handle('float:capture', async () => {
    await startCapture()
    return { ok: true }
  })

  ipcMain.on('float:capture-prewarm', () => prewarmCapture())
  ipcMain.on('float:capture-stop-prewarm', () => stopPrewarmSoon())

  ipcMain.handle('float:resize-by', (_event, payload) => {
    if (!float || float.win.isDestroyed()) return { ok: false }
    float.resizeBy(Number(payload?.dx) || 0, Number(payload?.dy) || 0)
    return { ok: true }
  })

  ipcMain.handle('float:hide', () => {
    if (float) float.hide()
    return { ok: true }
  })

  ipcMain.handle('float:quit', () => {
    app.quit()
    return { ok: true }
  })

  ipcMain.handle('float:open-external', async (_event, url) => {
    const value = String(url || '')
    if (!/^https?:\/\//i.test(value)) return { ok: false }
    await shell.openExternal(value)
    return { ok: true }
  })
}

/** Drives one chat through the bridge so tools/mock-host.mjs can check both directions. */
async function runSelfTest() {
  const log = (message) => process.stderr.write(`[selftest] ${message}\n`)

  const chatOnce = (abortAfterMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bridge.off('event', onEvent)
        reject(new Error('chat timed out'))
      }, 15_000)
      let streamed = ''
      const onEvent = (frame) => {
        if (frame.type === 'chat.delta') streamed += frame.text || ''
        if (frame.type === 'chat.done') {
          clearTimeout(timer)
          bridge.off('event', onEvent)
          resolve({ text: frame.text || streamed, aborted: Boolean(frame.aborted) })
        }
      }
      bridge.on('event', onEvent)
      bridge
        .request('chat.send', { text: 'selftest' })
        .then((ack) => {
          if (abortAfterMs == null) return
          setTimeout(() => {
            void bridge.request('chat.abort', { chatId: ack.chatId }).catch(() => {})
          }, abortAfterMs)
        })
        .catch((error) => {
          clearTimeout(timer)
          bridge.off('event', onEvent)
          reject(error)
        })
    })

  try {
    const catalog = await bridge.request('models.list')
    log(`models: ${(catalog?.providers || []).length} provider(s)`)
    const first = await chatOnce(120)
    log(`abort test: aborted=${first.aborted} chars=${first.text.length}`)
    const second = await chatOnce(null)
    log(`stream test: aborted=${second.aborted} chars=${second.text.length}`)
    if (!first.aborted || first.text.length === 0) throw new Error('abort path did not stream then stop')
    if (second.aborted || second.text.length === 0) throw new Error('stream path did not finish')
    await bridge.request('helper.quit').catch(() => {})
    log('ok')
    setTimeout(() => app.exit(0), 250)
  } catch (error) {
    log(`failed: ${error.message}`)
    app.exit(1)
  }
}

function watchHost() {
  if (MOCK || !HOST_PID) return
  setInterval(() => {
    if (quitting) return
    try {
      process.kill(HOST_PID, 0)
    } catch (error) {
      if (error && error.code === 'ESRCH') app.exit(0)
    }
  }, 2000)
}

app.on('second-instance', () => {
  if (float) float.show()
})

app.on('before-quit', () => {
  quitting = true
  petWatch?.stop()
  if (float) float.persistNow()
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
  bridge.close()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.whenReady().then(async () => {
  try {
    await bridge.start()
  } catch (error) {
    fail(`bridge failed to start: ${error.message}`)
  }

  float = createFloatWindow({
    preloadPath: PRELOAD,
    uiPath: UI_HTML,
    initialHotkey: PREFERRED_HOTKEY,
  })

  // Build the hidden selection overlay now so a screenshot click does not pay
  // for window creation and page load.
  prepareOverlay({ overlayPreload: OVERLAY_PRELOAD, overlayHtml: OVERLAY_HTML })

  bridge.on('event', (frame) => {
    if (frame.type === 'pet.dblclick') {
      toggleWindow()
      return
    }
    if (float && !float.win.isDestroyed()) float.win.webContents.send('float:event', frame)
  })

  wireIpc()
  buildTray()
  watchHost()

  petWatch = startPetWatch({
    port: bridge.port,
    token: bridge.token,
    epoch: EPOCH,
    helperPid: process.pid,
  })

  const registered = registerHotkey(PREFERRED_HOTKEY)
  if (registered) {
    hotkey = registered
    float.setHotkey(registered)
    if (registered !== PREFERRED_HOTKEY) {
      toast(`快捷键 ${PREFERRED_HOTKEY} 被占用，已改用 ${registered}`)
      void bridge.request('config.set', { hotkey: registered }).catch(() => {})
    }
  } else {
    hotkey = ''
    float.setHotkey('')
    toast('无法注册全局快捷键，请用托盘图标打开悬浮窗。')
  }
  process.stderr.write(`[dsh-float-helper] ready (hotkey ${hotkey})\n`)
  if (SELFTEST) void runSelfTest()
}).catch((error) => {
  fail(`startup failed: ${error && error.stack ? error.stack : error}`)
})

process.on('uncaughtException', (error) => {
  process.stderr.write(`[dsh-float-helper] uncaught: ${error && error.stack ? error.stack : error}\n`)
})
