'use strict'

const { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } = require('electron')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { debug } = require('./debug')

const SHOT_DIR = path.join(os.tmpdir(), 'dsh-float')
const OVERLAY_PAINT_TIMEOUT = 1600
const STREAM_FRAME_TIMEOUT = 4000
const STREAM_IDLE_TIMEOUT = 30_000
const SELECTION_TIMEOUT = 60_000

/* The overlay window is created once and reused: creating and loading a fresh
 * window on every capture cost ~200ms of the lag between click and selection. */
let overlay = null
let overlayLoad = null
let overlayLoaded = false
let overlayPreload = ''
let overlayHtml = ''
let overlayFailed = false
let prewarmTimer = null
let stopTimer = null
let captureSeq = 0

/* Source ids are only needed for displays other than the primary one; learning
 * them costs a full desktopCapturer call, so it happens off the critical path. */
const sourceIds = new Map()
let learning = null

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function overlayAlive() {
  return Boolean(overlay && !overlay.isDestroyed())
}

function resetOverlay() {
  overlay = null
  overlayLoad = null
  overlayLoaded = false
}

function createOverlay(rect) {
  const win = new BrowserWindow({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    useContentSize: true,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    opacity: 0,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: overlayPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // rAF must keep running while the window is still hidden at opacity 0.
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  overlay = win
  overlayLoaded = false
  overlayFailed = false
  overlayLoad = new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', () => {
      overlayLoaded = true
      resolve()
    })
    win.webContents.once('did-fail-load', (_event, code, description) => {
      overlayFailed = true
      if (overlay === win) resetOverlay()
      reject(new Error(`截图遮罩加载失败：${description} (${code})`))
    })
  })
  overlayLoad.catch(() => {})

  win.on('closed', () => {
    if (overlay === win) resetOverlay()
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    debug(`overlay renderer gone: ${details?.reason || 'unknown'}`)
    if (overlay === win) resetOverlay()
    try {
      win.destroy()
    } catch {
      /* ignore */
    }
  })

  debug(`overlay prewarmed rect=${JSON.stringify(rect)}`)
  win.loadFile(overlayHtml)
}

function boundsDiffer(current, rect) {
  return (
    current.x !== rect.x ||
    current.y !== rect.y ||
    current.width !== rect.width ||
    current.height !== rect.height
  )
}

async function ensureOverlay(area) {
  if (!overlayPreload || !overlayHtml) throw new Error('截图遮罩尚未初始化')
  const rect = { x: area.x, y: area.y, width: area.width, height: area.height }
  if (!overlayAlive()) {
    createOverlay(rect)
  } else if (!overlayFailed && boundsDiffer(overlay.getBounds(), rect)) {
    overlay.setBounds(rect)
  }
  try {
    await overlayLoad
  } catch (error) {
    try {
      if (overlayAlive()) overlay.destroy()
    } catch {
      /* ignore */
    }
    resetOverlay()
    throw error
  }
  if (!overlayAlive()) throw new Error('截图遮罩不可用')
  return overlay
}

/** Builds the overlay (hidden) and learns nothing about the screen yet. */
function prepareOverlay(options) {
  overlayPreload = options.overlayPreload
  overlayHtml = options.overlayHtml
  const area = screen.getPrimaryDisplay().workArea
  ensureOverlay(area).catch((error) => debug(`overlay prewarm failed: ${error.message}`))
}

function learnSources() {
  if (learning) return learning
  learning = desktopCapturer
    .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    .then((sources) => {
      sourceIds.clear()
      for (const source of sources) {
        if (source.display_id) sourceIds.set(String(source.display_id), source.id)
      }
    })
    .catch((error) => debug(`learnSources failed: ${error.message}`))
    .finally(() => {
      learning = null
    })
  return learning
}

function streamSpec(display) {
  const scale = display.scaleFactor || 1
  return {
    displayId: display.id,
    sourceId: sourceIds.get(String(display.id)) || null,
    displayBounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: scale,
    maxWidth: Math.round(display.bounds.width * scale),
    maxHeight: Math.round(display.bounds.height * scale),
  }
}

function streamEligible(display) {
  if (String(display.id) === String(screen.getPrimaryDisplay().id)) return true
  return sourceIds.has(String(display.id))
}

/**
 * Starts the screen stream on hover so the click itself only has to pull one
 * frame. Without this the stream setup (~300ms) lands inside the click gap.
 */
function prewarmCapture() {
  if (!overlayAlive() || !overlayLoaded) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (!streamEligible(display)) return
  try {
    overlay.webContents.send('float:overlay-prewarm', streamSpec(display))
  } catch (error) {
    debug(`prewarm send failed: ${error.message}`)
    return
  }
  clearTimeout(stopTimer)
  stopTimer = null
  clearTimeout(prewarmTimer)
  prewarmTimer = setTimeout(() => stopStream(), STREAM_IDLE_TIMEOUT)
  prewarmTimer.unref?.()
}

/** The cursor left the camera button; give the click a moment, then release the stream. */
function stopPrewarmSoon() {
  clearTimeout(stopTimer)
  stopTimer = setTimeout(() => {
    stopTimer = null
    stopStream()
  }, 3000)
  stopTimer.unref?.()
}

function stopStream() {
  clearTimeout(prewarmTimer)
  prewarmTimer = null
  clearTimeout(stopTimer)
  stopTimer = null
  if (!overlayAlive()) return
  try {
    overlay.webContents.send('float:overlay-stop')
  } catch {
    /* window is going away */
  }
}

function ensureShotDir() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  return SHOT_DIR
}

function shotPath() {
  ensureShotDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(SHOT_DIR, `shot-${stamp}-${Math.random().toString(36).slice(2, 8)}.png`)
}

function powerShellCapture(physicalRect, outPath) {
  const { x, y, width, height } = physicalRect
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DshDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'`,
    "[void][DshDpi]::SetProcessDPIAware()",
    `$bmp = New-Object System.Drawing.Bitmap(${Math.max(1, Math.round(width))}, ${Math.max(1, Math.round(height))})`,
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    `$g.CopyFromScreen(${Math.round(x)}, ${Math.round(y)}, 0, 0, $bmp.Size)`,
    `$bmp.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose(); $bmp.Dispose()",
  ].join('; ')

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 12_000 },
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
  })
}

async function grabDisplay(display) {
  const scale = display.scaleFactor || 1
  const target = {
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale),
  }
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: target })
    const source =
      sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
    if (source && !source.thumbnail.isEmpty()) {
      return { image: source.thumbnail, bounds: display.bounds }
    }
  } catch {
    /* fall through to the Windows capture path */
  }

  const physical = screen.dipToScreenRect(null, display.bounds)
  const out = shotPath()
  await powerShellCapture(physical, out)
  const image = nativeImage.createFromPath(out)
  if (image.isEmpty()) throw new Error('桌面截图失败')
  return { image, bounds: display.bounds, temp: out }
}

/**
 * The overlay window is clamped by Windows to the work area, so narrow the
 * captured image to the same rect; otherwise the picture is squashed relative
 * to the selection coordinates.
 */
function cropToArea(image, fullBounds, area) {
  if (
    area.x === fullBounds.x &&
    area.y === fullBounds.y &&
    area.width === fullBounds.width &&
    area.height === fullBounds.height
  ) {
    return image
  }
  const size = image.getSize()
  const scaleX = size.width / fullBounds.width
  const scaleY = size.height / fullBounds.height
  const x = Math.max(0, Math.round((area.x - fullBounds.x) * scaleX))
  const y = Math.max(0, Math.round((area.y - fullBounds.y) * scaleY))
  const width = Math.min(size.width - x, Math.round(area.width * scaleX))
  const height = Math.min(size.height - y, Math.round(area.height * scaleY))
  if (width < 2 || height < 2) return image
  return image.crop({ x, y, width, height })
}

function cropAndSave(image, bounds, rect) {
  const size = image.getSize()
  const scaleX = size.width / bounds.width
  const scaleY = size.height / bounds.height
  const x = Math.max(0, Math.round(rect.x * scaleX))
  const y = Math.max(0, Math.round(rect.y * scaleY))
  const width = Math.min(size.width - x, Math.round(rect.width * scaleX))
  const height = Math.min(size.height - y, Math.round(rect.height * scaleY))
  if (width < 2 || height < 2) throw new Error('选区太小')
  const cropped = image.crop({ x, y, width, height })
  const out = shotPath()
  fs.writeFileSync(out, cropped.toPNG())
  return out
}

/** Asks the hidden overlay renderer for one frame; it waits for the float to disappear. */
function requestFrame(win, id, spec) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ipcMain.removeListener('float:overlay-frame', onFrame)
      ipcMain.removeListener('float:overlay-failed', onFailed)
      resolve(value)
    }
    const onFrame = (event, payload) => {
      if (event.sender !== win.webContents) return
      if (!payload || payload.id !== id || !payload.buffer) return
      finish({
        buffer: payload.buffer,
        ms: payload.ms,
        wait: payload.wait,
        encode: payload.encode,
        display: payload.display,
      })
    }
    const onFailed = (event, payload) => {
      if (event.sender !== win.webContents) return
      if (payload && payload.id !== id) return
      finish({ error: (payload && payload.message) || '屏幕流截图失败' })
    }
    const timer = setTimeout(() => finish({ error: '屏幕流截图超时' }), STREAM_FRAME_TIMEOUT)
    ipcMain.on('float:overlay-frame', onFrame)
    ipcMain.on('float:overlay-failed', onFailed)
    win.webContents.send('float:overlay-capture', { id, ...spec })
  })
}

/** Waits until the renderer has painted the image, so the overlay never flashes black. */
function requestPaint(win, id) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ipcMain.removeListener('float:overlay-painted', onPainted)
      resolve(value)
    }
    const onPainted = (event, payload) => {
      if (event.sender !== win.webContents) return
      if (payload && payload.id !== id) return
      finish(true)
    }
    const timer = setTimeout(() => finish(false), OVERLAY_PAINT_TIMEOUT)
    ipcMain.on('float:overlay-painted', onPainted)
    win.webContents.send('float:overlay-paint', { id })
  })
}

/** Shows the overlay invisible, lets it composite, then fades it in. */
async function presentOverlay(win, id) {
  win.setOpacity(0)
  let visible = false
  for (let attempt = 0; attempt < 6 && !visible; attempt += 1) {
    try {
      win.show()
    } catch (error) {
      debug(`overlay show threw: ${error.message}`)
      return false
    }
    visible = win.isVisible()
    if (!visible) await delay(50)
  }
  if (!visible) return false
  win.setAlwaysOnTop(true, 'screen-saver')
  const painted = await requestPaint(win, id)
  if (win.isDestroyed()) return false
  win.setOpacity(1)
  try {
    win.focus()
  } catch {
    /* focus is best effort; pointer events still work */
  }
  debug(`overlay revealed painted=${painted}`)
  return true
}

function selectRegion(win, image, bounds) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener('float:overlay-done', onDone)
      ipcMain.removeListener('float:overlay-cancel', onCancel)
      resolve(value)
    }
    const onDone = (event, rect) => {
      if (event.sender !== win.webContents) return
      if (!rect || rect.width < 2 || rect.height < 2) return settle(null)
      try {
        settle(cropAndSave(image, bounds, rect))
      } catch (error) {
        debug(`crop failed: ${error.message}`)
        settle(null)
      }
    }
    const onCancel = (event) => {
      if (event.sender === win.webContents) settle(null)
    }
    const timer = setTimeout(() => settle(null), SELECTION_TIMEOUT)
    timer.unref?.()
    ipcMain.on('float:overlay-done', onDone)
    ipcMain.on('float:overlay-cancel', onCancel)
  })
}

/**
 * Capture one display, show an opaque selection overlay on it, and return the
 * path of the cropped PNG (or null when the user cancels).
 */
async function captureRegion({ floatWindow, overlayPreload: preloadPath, overlayHtml: htmlPath }) {
  overlayPreload = preloadPath
  overlayHtml = htmlPath

  clearTimeout(stopTimer)
  stopTimer = null

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wasVisible = floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()
  const started = Date.now()
  debug(
    `capture start display=${display.id} workArea=${JSON.stringify(display.workArea)} wasVisible=${wasVisible}`,
  )
  /*
   * hide() can animate (a ~190ms fade) when the panel has focus, which shows up
   * as a ghost in the captured frame; opacity reaches zero in one frame.
   */
  if (wasVisible) {
    try {
      floatWindow.setOpacity(0)
    } catch {
      /* hiding below is enough */
    }
    try {
      floatWindow.hide()
    } catch {
      /* ignore */
    }
  }

  let image = null
  let temp = null
  let result = null
  let failure = null
  const id = ++captureSeq

  try {
    const win = await ensureOverlay(display.workArea)
    if (win.isVisible()) win.hide()
    let streamMode = false

    if (streamEligible(display)) {
      const frame = await requestFrame(win, id, streamSpec(display))
      if (frame && frame.buffer) {
        const decoded = nativeImage.createFromBuffer(Buffer.from(frame.buffer))
        if (!decoded.isEmpty()) {
          const size = decoded.getSize()
          const expectedWidth = Math.round(display.workArea.width * (display.scaleFactor || 1))
          const expectedHeight = Math.round(display.workArea.height * (display.scaleFactor || 1))
          const fits =
            Math.abs(size.width / expectedWidth - 1) < 0.05 &&
            Math.abs(size.height / expectedHeight - 1) < 0.05
          if (fits) {
            image = decoded
            streamMode = true
            debug(
              `stream frame ${size.width}x${size.height} renderer=${frame.ms || '?'}ms wait=${frame.wait || '?'} encode=${frame.encode || '?'} display=${frame.display || '?'}`,
            )
          } else {
            debug(`stream frame size mismatch ${size.width}x${size.height} expected ${expectedWidth}x${expectedHeight}`)
          }
        }
      }
      if (frame && frame.error) debug(`stream capture failed: ${frame.error}`)
      if (!streamMode) {
        stopStream()
        void learnSources()
      }
    }

    if (!image) {
      const full = await grabDisplay(display)
      image = cropToArea(full.image, display.bounds, display.workArea)
      temp = full.temp
      debug(`capture grabbed size=${JSON.stringify(image.getSize())} temp=${temp || ''}`)
      if (!streamEligible(display)) void learnSources()
    }

    // The image is only painted while the overlay is still invisible.
    let sent = false
    if (!streamMode) {
      if (!win.isDestroyed()) {
        win.webContents.send('float:overlay-data', {
          id,
          image: image.toDataURL(),
          width: display.workArea.width,
          height: display.workArea.height,
        })
        sent = true
      }
    }
    if (streamMode) stopStream()

    const shown = await presentOverlay(win, id)
    if (!shown) throw new Error('截图遮罩未能显示')
    if (!streamMode && !sent) throw new Error('截图数据未能送达遮罩')

    result = await selectRegion(win, image, display.workArea)
    debug(`capture done in ${Date.now() - started}ms`)
  } catch (error) {
    failure = error
    debug(`capture failed after ${Date.now() - started}ms: ${error && error.stack ? error.stack : error}`)
    throw error
  } finally {
    stopStream()
    if (overlayAlive()) {
      try {
        if (overlay.isVisible()) overlay.hide()
        overlay.setOpacity(0)
      } catch {
        /* the window may already be gone */
      }
    }
    if (temp) {
      try {
        fs.unlinkSync(temp)
      } catch {
        /* ignore */
      }
    }
    if (wasVisible && floatWindow && !floatWindow.isDestroyed()) {
      try {
        floatWindow.setOpacity(1)
      } catch {
        /* restoring opacity is best effort */
      }
      floatWindow.showInactive()
      try {
        floatWindow.setAlwaysOnTop(true, 'screen-saver')
        floatWindow.moveTop()
      } catch {
        /* topmost is best effort */
      }
    }
    debug(
      `capture finish result=${result || 'null'} error=${failure ? failure.message : ''} total=${Date.now() - started}ms`,
    )
  }
  return result
}

module.exports = {
  captureRegion,
  prepareOverlay,
  prewarmCapture,
  stopPrewarmSoon,
  learnSources,
  SHOT_DIR,
  shotPath,
}
