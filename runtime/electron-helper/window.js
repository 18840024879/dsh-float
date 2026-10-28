'use strict'

const { BrowserWindow, screen } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { debug } = require('./debug')

const PANEL_WIDTH = 380
const PANEL_HEIGHT = 560
const MIN_WIDTH = 320
const MIN_HEIGHT = 420
const EDGE_MARGIN = 24

const DATA_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-float')
const BOUNDS_FILE = path.join(DATA_DIR, 'window.json')

function readBounds() {
  try {
    const value = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'))
    if (!value) return null
    const { x, y, width, height } = value
    if (![x, y, width, height].every((item) => Number.isFinite(item))) return null
    // Orb-era files stored a 72 px square; start fresh instead of opening a tiny
    // panel. The floor is below MIN_WIDTH because saved sizes are content sizes.
    if (width < 200 || height < 200) return null
    return { x, y, width, height }
  } catch {
    /* first run */
  }
  return null
}

function writeBounds(bounds) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(bounds), 'utf8')
  } catch {
    /* geometry is a nicety, never fatal */
  }
}

function clampToWorkArea(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) })
  const area = display.workArea
  const w = Math.min(Math.max(Math.round(width), MIN_WIDTH), area.width)
  const h = Math.min(Math.max(Math.round(height), MIN_HEIGHT), area.height)
  return {
    x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - w),
    y: Math.min(Math.max(Math.round(y), area.y), area.y + area.height - h),
    width: w,
    height: h,
  }
}

function defaultPanelBounds() {
  const area = screen.getPrimaryDisplay().workArea
  return clampToWorkArea(
    area.x + area.width - PANEL_WIDTH - EDGE_MARGIN,
    area.y + area.height - PANEL_HEIGHT - EDGE_MARGIN,
    PANEL_WIDTH,
    PANEL_HEIGHT,
  )
}

/*
 * On Windows the topmost style does not stick to a transparent frameless
 * window created hidden; re-assert it every time the window is shown,
 * otherwise a maximized app window covers the panel.
 */
function assertTopmost(win) {
  if (!win || win.isDestroyed()) return
  try {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
    debug(`topmost asserted on=${win.isAlwaysOnTop()} visible=${win.isVisible()}`)
  } catch (error) {
    debug(`topmost assert failed: ${error && error.message}`)
  }
}

function createFloatWindow({ preloadPath, uiPath, initialHotkey }) {
  const saved = readBounds()
  const bounds = saved ? clampToWorkArea(saved.x, saved.y, saved.width, saved.height) : defaultPanelBounds()

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    show: false,
    // Width/height are content sizes so the saved size is frame-independent.
    useContentSize: true,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  // Position after creation: passing x/y to the constructor makes Windows
  // report a window ~4 DIP wider each launch, so the saved size crept up.
  win.setBounds(bounds)
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  debug(
    `bounds created requested=${JSON.stringify(bounds)} saved=${JSON.stringify(saved)} ` +
      `outer=${JSON.stringify(win.getBounds())} content=${JSON.stringify(win.getContentBounds())}`,
  )

  let saveTimer = null
  // Window sizes are integers in DIP, so accumulate the unrounded size here or
  // small per-move deltas (e.g. 6.67 px) would lose their fraction every step.
  let resizeAcc = null

  function persistNow() {
    if (win.isDestroyed()) return
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const current = win.getBounds()
    if (current.width < MIN_WIDTH || current.height < MIN_HEIGHT) return
    const content = win.getContentBounds()
    debug(`bounds persist outer=${JSON.stringify(current)} content=${JSON.stringify(content)}`)
    writeBounds({ x: current.x, y: current.y, width: content.width, height: content.height })
  }

  function persist() {
    if (win.isDestroyed()) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistNow()
    }, 250)
  }

  // useContentSize makes setBounds() use content units, while getBounds()
  // reports the outer window, so size math works on content bounds.
  function contentBounds() {
    const outer = win.getBounds()
    const content = win.getContentBounds()
    return { x: outer.x, y: outer.y, width: content.width, height: content.height }
  }

  function show() {
    if (win.isDestroyed()) return
    const current = contentBounds()
    const fixed = clampToWorkArea(current.x, current.y, current.width, current.height)
    if (
      fixed.x !== current.x ||
      fixed.y !== current.y ||
      fixed.width !== current.width ||
      fixed.height !== current.height
    ) {
      win.setBounds(fixed)
    }
    win.show()
    assertTopmost(win)
    win.focus()
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('float:event', { type: 'view', view: 'panel' })
    }
  }

  function hide() {
    if (win.isDestroyed()) return
    persistNow()
    win.hide()
  }

  function toggle() {
    if (win.isDestroyed()) return
    if (win.isVisible()) hide()
    else show()
  }

  function resizeBy(dw, dh) {
    if (win.isDestroyed()) return
    const current = contentBounds()
    if (
      !resizeAcc ||
      Math.abs(resizeAcc.width - current.width) > 1 ||
      Math.abs(resizeAcc.height - current.height) > 1
    ) {
      resizeAcc = { width: current.width, height: current.height }
    }
    const display = screen.getDisplayNearestPoint({
      x: current.x + Math.round(current.width / 2),
      y: current.y + Math.round(current.height / 2),
    })
    const area = display.workArea
    const maxWidth = Math.min(area.width, Math.max(MIN_WIDTH, area.x + area.width - current.x))
    const maxHeight = Math.min(area.height, Math.max(MIN_HEIGHT, area.y + area.height - current.y))
    const width = Math.min(Math.max(resizeAcc.width + dw, MIN_WIDTH), maxWidth)
    const height = Math.min(Math.max(resizeAcc.height + dh, MIN_HEIGHT), maxHeight)
    resizeAcc.width = width
    resizeAcc.height = height
    const roundedWidth = Math.round(width)
    const roundedHeight = Math.round(height)
    if (roundedWidth === current.width && roundedHeight === current.height) return
    win.setBounds({ x: current.x, y: current.y, width: roundedWidth, height: roundedHeight })
  }

  function updateHotkeyNotice(message) {
    if (!win.isDestroyed()) win.webContents.send('float:event', { type: 'toast', message })
  }

  function setHotkey(value) {
    if (!win.isDestroyed()) win.webContents.send('float:event', { type: 'init', hotkey: value })
  }

  win.on('moved', persist)
  // 'resized' does not fire on a programmatically resized frameless window.
  win.on('resize', persist)
  win.on('show', () => assertTopmost(win))
  win.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer)
  })

  screen.on('display-metrics-changed', () => {
    if (win.isDestroyed()) return
    const current = contentBounds()
    const fixed = clampToWorkArea(current.x, current.y, current.width, current.height)
    win.setBounds(fixed)
  })

  win.loadFile(uiPath)

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('float:event', { type: 'init', hotkey: initialHotkey })
  })

  return {
    win,
    show,
    hide,
    toggle,
    resizeBy,
    assertTopmost: () => assertTopmost(win),
    updateHotkeyNotice,
    setHotkey,
    persistNow,
    isVisible: () => !win.isDestroyed() && win.isVisible(),
  }
}

module.exports = { createFloatWindow, PANEL_WIDTH, PANEL_HEIGHT, MIN_WIDTH, MIN_HEIGHT }
