import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  discardScreenshot,
  listCatalog,
  readScreenshot,
  resolveRouteForRequest,
  runChat,
  sanitizePreview,
} from './chat.js'
import {
  DATA_DIR,
  loadConfig,
  loadHistory,
  saveConfig,
  saveHistory,
} from './config.js'
import { createLineBuffer, isFreshEpoch } from './protocol.js'

export const name = 'dsh-float'
export const inject = ['llm', 'agentDefaultModel', 'attachments']

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELPER_MAIN = join(PLUGIN_ROOT, 'runtime', 'electron-helper', 'main.js')
const ACTIVE = Symbol.for('dsh-float.active')
const MAX_FAILURES = 12
const BASE_DELAY = 750
const MAX_DELAY = 30_000
const STABLE_MS = 3 * 60_000
const ELECTRON_VERSION = '43.3.0'
const ELECTRON_ARCH = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64'
const ELECTRON_ROOT = join(DATA_DIR, 'electron')
const ELECTRON_DIR = join(ELECTRON_ROOT, `v${ELECTRON_VERSION}-win32-${ELECTRON_ARCH}`)
const ELECTRON_EXE = join(ELECTRON_DIR, 'electron.exe')

let epochCounter = 0
let electronDownload = null

function log(message) {
  console.error(`[dsh-float] ${message}`)
}

function electronCandidates() {
  const candidates = []
  if (process.env.DSH_FLOAT_ELECTRON_PATH) candidates.push(process.env.DSH_FLOAT_ELECTRON_PATH)
  if (process.env.DSH_PET_ELECTRON_PATH) candidates.push(process.env.DSH_PET_ELECTRON_PATH)
  try {
    const require = createRequire(import.meta.url)
    const fromPackage = require('electron')
    if (typeof fromPackage === 'string' && fromPackage) candidates.push(fromPackage)
  } catch {
    /* electron is not a dependency of the plugin */
  }
  candidates.push(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'electron', 'electron.exe'))
  candidates.push(ELECTRON_EXE)
  return candidates.filter((value) => typeof value === 'string' && value)
}

function findElectron() {
  return electronCandidates().find((value) => existsSync(value)) ?? null
}

function runPowerShell(script, env, timeout) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim().slice(-600)
          rejectPromise(new Error(detail || error.message))
          return
        }
        resolvePromise({ stdout, stderr })
      },
    )
  })
}

const ELECTRON_INSTALL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (Test-Path -LiteralPath $env:DSH_FLOAT_ELECTRON_STAGING) {
  Remove-Item -LiteralPath $env:DSH_FLOAT_ELECTRON_STAGING -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $env:DSH_FLOAT_ELECTRON_STAGING | Out-Null
$ok = $false
foreach ($u in @($env:DSH_FLOAT_ELECTRON_URL, $env:DSH_FLOAT_ELECTRON_URL_FALLBACK)) {
  try {
    Invoke-WebRequest -Uri $u -OutFile $env:DSH_FLOAT_ELECTRON_ZIP -UseBasicParsing -TimeoutSec 900
    $ok = $true
    break
  } catch {
    Write-Output ('source failed: ' + $u + ' ' + $_.Exception.Message)
  }
}
if (-not $ok) { throw 'every Electron download source failed' }
$tar = Join-Path $env:WINDIR 'System32\tar.exe'
if (Test-Path -LiteralPath $tar) {
  & $tar -xf $env:DSH_FLOAT_ELECTRON_ZIP -C $env:DSH_FLOAT_ELECTRON_STAGING
  if ($LASTEXITCODE -ne 0) { Expand-Archive -LiteralPath $env:DSH_FLOAT_ELECTRON_ZIP -DestinationPath $env:DSH_FLOAT_ELECTRON_STAGING -Force }
} else {
  Expand-Archive -LiteralPath $env:DSH_FLOAT_ELECTRON_ZIP -DestinationPath $env:DSH_FLOAT_ELECTRON_STAGING -Force
}
`.trim()

async function downloadElectron() {
  const staging = `${ELECTRON_DIR}.download`
  const zip = join(ELECTRON_ROOT, `electron-v${ELECTRON_VERSION}-win32-${ELECTRON_ARCH}.zip`)
  const file = `electron-v${ELECTRON_VERSION}-win32-${ELECTRON_ARCH}.zip`
  const urls = [
    `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/${file}`,
    `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${file}`,
  ]
  mkdirSync(ELECTRON_ROOT, { recursive: true })
  log(`Electron not found; downloading ${ELECTRON_VERSION} win32-${ELECTRON_ARCH} (one time)`)
  const startedAt = Date.now()
  try {
    await runPowerShell(ELECTRON_INSTALL_SCRIPT, {
      DSH_FLOAT_ELECTRON_STAGING: staging,
      DSH_FLOAT_ELECTRON_ZIP: zip,
      DSH_FLOAT_ELECTRON_URL: urls[0],
      DSH_FLOAT_ELECTRON_URL_FALLBACK: urls[1],
    }, 15 * 60_000)
    if (!existsSync(join(staging, 'electron.exe')) || !existsSync(join(staging, 'ffmpeg.dll'))) {
      throw new Error('downloaded archive did not contain a usable Electron runtime')
    }
    rmSync(ELECTRON_DIR, { recursive: true, force: true })
    renameSync(staging, ELECTRON_DIR)
    rmSync(zip, { force: true })
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    rmSync(zip, { force: true })
    throw error
  }
  log(`Electron ${ELECTRON_VERSION} installed in ${Math.round((Date.now() - startedAt) / 1000)}s`)
  return ELECTRON_EXE
}

async function resolveElectron() {
  const found = findElectron()
  if (found) return found
  if (process.platform !== 'win32') return null
  if (!electronDownload) {
    electronDownload = downloadElectron().finally(() => {
      electronDownload = null
    })
  }
  return electronDownload
}

export function apply(ctx) {
  const config = loadConfig()
  let history = loadHistory()
  const epoch = ++epochCounter

  let child = null
  let disposed = false
  let stopping = false
  let ready = null
  let failures = 0
  let restartTimer = null
  let stableTimer = null
  let pingTimer = null
  let activeChat = null
  let disposedOnce = false

  const abortControllers = new Map()

  function post(frame) {
    if (!ready) return Promise.resolve(false)
    const body = JSON.stringify({ ...frame, epoch })
    return fetch(`http://127.0.0.1:${ready.port}/bridge`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-float-token': ready.token,
      },
      body,
      signal: AbortSignal.timeout(4000),
    })
      .then((res) => res.ok)
      .catch(() => false)
  }

  function onFrame(frame) {
    if (!isFreshEpoch(epoch, frame.epoch)) return
    if (frame.type === 'ready') {
      ready = {
        port: Number(frame.port) || 0,
        token: String(frame.token || ''),
        pid: Number(frame.pid) || 0,
      }
      // Failures only clear after a stable stretch; otherwise a helper that
      // becomes ready and dies immediately would restart forever.
      if (stableTimer) clearTimeout(stableTimer)
      stableTimer = setTimeout(() => {
        failures = 0
      }, STABLE_MS)
      log(`helper ready on 127.0.0.1:${ready.port} (pid ${ready.pid})`)
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        void post({ type: 'ping' })
      }, 15_000)
      return
    }
    if (frame.type === 'log') {
      log(`${frame.level || 'info'}: ${frame.message || ''}`)
      return
    }
    if (frame.type === 'req') {
      void handleRequest(frame).catch((error) => {
        log(`request ${frame.id} failed: ${error?.message || error}`)
      })
    }
  }

  async function handleRequest(frame) {
    const id = frame.id
    const method = String(frame.method || '')
    const params = frame.params && typeof frame.params === 'object' ? frame.params : {}

    const respond = (ok, payload, error) =>
      post(ok ? { type: 'res', id, ok: true, data: payload } : { type: 'res', id, ok: false, error })

    try {
      if (method === 'models.list') {
        return await respond(true, await listCatalog(ctx, config))
      }

      if (method === 'config.get') {
        return await respond(true, { config, history })
      }

      if (method === 'config.set') {
        if (params.hotkey && typeof params.hotkey === 'string') config.hotkey = params.hotkey.trim() || config.hotkey
        if (typeof params.systemPrompt === 'string' && params.systemPrompt.trim()) {
          config.systemPrompt = params.systemPrompt
        }
        if (params.model === null) config.model = null
        else if (params.model && typeof params.model.provider === 'string' && typeof params.model.model === 'string') {
          config.model = { provider: params.model.provider, model: params.model.model }
        }
        if (typeof params.autoVision === 'boolean') config.autoVision = params.autoVision
        saveConfig(config)
        return await respond(true, { config })
      }

      if (method === 'chat.abort') {
        const chat = abortControllers.get(String(params.chatId || ''))
        if (chat) chat.abort()
        return await respond(true, { aborted: Boolean(chat) })
      }

      if (method === 'history.clear') {
        history = []
        saveHistory(history)
        return await respond(true, { ok: true })
      }

      if (method === 'chat.send') {
        if (activeChat) return await respond(false, undefined, { code: 'BUSY', message: '上一条回答还没结束。' })
        const text = typeof params.text === 'string' ? params.text : ''
        const imagePath = typeof params.imagePath === 'string' ? params.imagePath : null
        const imagePreview = sanitizePreview(params.imagePreview)
        if (!text.trim() && !imagePath) {
          return await respond(false, undefined, { code: 'EMPTY_INPUT', message: '请输入内容。' })
        }

        const routed = await resolveRouteForRequest(ctx, config, { needsImage: Boolean(imagePath) })
        const route = routed.vision || routed.route

        let imageRef = null
        if (imagePath) {
          if (!ctx.attachments || typeof ctx.attachments.saveImage !== 'function') {
            throw Object.assign(new Error('附件服务不可用，无法发送图片。'), { code: 'ATTACHMENT_UNAVAILABLE' })
          }
          const shot = readScreenshot(imagePath)
          imageRef = await ctx.attachments.saveImage({
            data: shot.bytes,
            mediaType: shot.mediaType,
            name: basename(shot.path),
          })
        }

        const controller = new AbortController()
        const chatId = String(id)
        abortControllers.set(chatId, controller)
        activeChat = chatId

        // Acknowledge before streaming so the helper can show the pending bubble.
        await respond(true, {
          chatId,
          route,
          switched: Boolean(routed.vision),
          image: Boolean(imageRef),
        })

        let seq = 0
        let pending = ''
        let flushTimer = null
        const flush = () => {
          if (!pending) return
          const textDelta = pending
          pending = ''
          void post({ type: 'chat.delta', id: chatId, seq: seq++, text: textDelta })
        }
        const scheduleFlush = () => {
          if (flushTimer) return
          flushTimer = setTimeout(() => {
            flushTimer = null
            flush()
          }, 50)
        }

        try {
          const result = await runChat(ctx, {
            route,
            history,
            text,
            imageRef,
            system: config.systemPrompt,
            signal: controller.signal,
            maxHistoryRounds: config.maxHistoryRounds,
            onDelta: (delta) => {
              pending += delta
              if (pending.length >= 512) {
                if (flushTimer) {
                  clearTimeout(flushTimer)
                  flushTimer = null
                }
                flush()
              } else {
                scheduleFlush()
              }
            },
          })
          if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = null
          }
          flush()
          const userEntry = { role: 'user', text: text || '[截图]' }
          if (imagePreview) userEntry.image = imagePreview
          history = [...history, userEntry, { role: 'assistant', text: result.text }]
          if (history.length > 40) history = history.slice(-40)
          saveHistory(history)
          await post({
            type: 'chat.done',
            id: chatId,
            text: result.text,
            route: result.route,
            aborted: false,
          })
        } catch (error) {
          if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = null
          }
          const aborted = error?.name === 'AbortError' || controller.signal.aborted
          await post({
            type: 'chat.done',
            id: chatId,
            text: '',
            aborted,
            error: aborted
              ? { code: 'ABORTED', message: '已停止。' }
              : { code: error?.code || 'CHAT_FAILED', message: error?.message || String(error) },
          })
        } finally {
          abortControllers.delete(chatId)
          activeChat = null
          if (imagePath) discardScreenshot(imagePath)
        }
        return
      }

      if (method === 'helper.quit') {
        await respond(true, { ok: true })
        stop('helper requested quit')
        return
      }

      return await respond(false, undefined, { code: 'UNKNOWN_METHOD', message: `未知方法 ${method}` })
    } catch (error) {
      if (method === 'chat.send' && typeof params.imagePath === 'string') {
        discardScreenshot(params.imagePath)
      }
      return respond(false, undefined, { code: error?.code || 'REQUEST_FAILED', message: error?.message || String(error) })
    }
  }

  async function start() {
    if (disposed) return
    let electron = null
    try {
      electron = await resolveElectron()
    } catch (error) {
      log(`Electron unavailable: ${error?.message || error}`)
      log('Set DSH_FLOAT_ELECTRON_PATH to an electron.exe to skip the download.')
      return
    }
    if (disposed) return
    if (!electron) {
      log('Electron not found; set DSH_FLOAT_ELECTRON_PATH or install the dsh desktop app.')
      return
    }
    if (!existsSync(HELPER_MAIN)) {
      log(`helper missing at ${HELPER_MAIN}`)
      return
    }

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.DSH_FLOAT_HOST_PID = String(process.pid)
    env.DSH_FLOAT_EPOCH = String(epoch)
    env.DSH_FLOAT_PLUGIN_ROOT = PLUGIN_ROOT
    env.DSH_FLOAT_HOTKEY = config.hotkey

    const proc = spawn(electron, [HELPER_MAIN], {
      cwd: PLUGIN_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = proc
    stopping = false
    ready = null

    const lines = createLineBuffer(onFrame)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => lines.push(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log(`helper: ${text.split('\n').slice(-3).join(' | ')}`)
    })
    proc.once('error', (error) => {
      log(`helper failed to start: ${error.message}`)
    })
    proc.once('exit', (code, signal) => {
      if (child !== proc) return
      child = null
      ready = null
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      if (stopping || disposed) return
      log(`helper exited (code=${code}, signal=${signal}); restarting`)
      scheduleRestart()
    })
  }

  function scheduleRestart() {
    if (disposed || restartTimer) return
    failures += 1
    if (failures > MAX_FAILURES) {
      log(`helper crashed ${failures} times; giving up until dsh restarts`)
      return
    }
    const delay = Math.min(MAX_DELAY, BASE_DELAY * 2 ** (failures - 1))
    log(`restart in ${delay}ms (attempt ${failures}/${MAX_FAILURES})`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      void start()
    }, delay)
  }

  function stop(reason) {
    if (disposedOnce) return
    disposedOnce = true
    disposed = true
    stopping = true
    if (restartTimer) clearTimeout(restartTimer)
    if (stableTimer) clearTimeout(stableTimer)
    if (pingTimer) clearInterval(pingTimer)
    restartTimer = stableTimer = pingTimer = null
    for (const controller of abortControllers.values()) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    abortControllers.clear()
    activeChat = null
    if (child) {
      const proc = child
      child = null
      log(`stopping helper (${reason})`)
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 2000)
      killTimer.unref?.()
      proc.once('exit', () => clearTimeout(killTimer))
    }
    if (globalThis[ACTIVE] === controller) delete globalThis[ACTIVE]
  }

  const controller = { stop }
  const previous = globalThis[ACTIVE]
  if (previous && typeof previous.stop === 'function') {
    try {
      previous.stop('replaced by reload')
    } catch {
      /* ignore */
    }
  }
  globalThis[ACTIVE] = controller

  ctx.effect(() => {
    void start()
    return () => stop('plugin disposed')
  }, 'dsh-float desktop helper')

  log('loaded')
}

export function readPluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}
