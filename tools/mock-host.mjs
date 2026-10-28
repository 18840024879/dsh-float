#!/usr/bin/env node
/**
 * Standalone bridge smoke test: spawns the Electron helper with --selftest and
 * plays the host side, without touching a running DeepSeek Harness.
 *
 *   node tools/mock-host.mjs
 *
 * Covers: ready frame + token auth + epoch check, request/response in both
 * directions, streaming deltas, abort, and helper shutdown.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const ELECTRON =
  process.env.DSH_FLOAT_ELECTRON_PATH || join(DSH_HOME, 'electron', 'electron.exe')
const HELPER = join(ROOT, 'runtime', 'electron-helper', 'main.js')
const EPOCH = 7
const PREFIX = 'dsh-float-bridge:'
const TIMEOUT_MS = 40_000

if (!existsSync(ELECTRON)) {
  console.error(`Electron not found at ${ELECTRON}; set DSH_FLOAT_ELECTRON_PATH.`)
  process.exit(1)
}
if (!existsSync(HELPER)) {
  console.error(`Helper not found at ${HELPER}.`)
  process.exit(1)
}

const CONFIG = {
  hotkey: 'Alt+Space',
  systemPrompt: '',
  model: null,
  maxHistoryRounds: 8,
  autoVision: true,
  opacity: 1,
}

let ready = null
let child = null
let finished = false
const chats = new Map()
const seen = { aborted: false, completed: false }
let chatCounter = 0

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.DSH_FLOAT_HOST_PID = String(process.pid)
env.DSH_FLOAT_EPOCH = String(EPOCH)
env.DSH_FLOAT_PLUGIN_ROOT = ROOT
env.DSH_FLOAT_HOTKEY = 'Ctrl+Alt+Shift+F11'

function done(code, message) {
  if (finished) return
  finished = true
  clearTimeout(guard)
  for (const chat of chats.values()) clearInterval(chat.timer)
  if (child && !child.killed) child.kill()
  if (message) console.log(message)
  setTimeout(() => process.exit(code), 150)
}

function fail(message) {
  done(1, `FAIL: ${message}`)
}

const guard = setTimeout(() => fail('timed out'), TIMEOUT_MS)

function respond(id, ok, data, error) {
  void post(ok ? { type: 'res', id, ok: true, data } : { type: 'res', id, ok: false, error })
}

async function post(frame) {
  if (!ready) return 0
  try {
    const response = await fetch(`http://127.0.0.1:${ready.port}/bridge`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-float-token': ready.token,
      },
      body: JSON.stringify({ ...frame, epoch: EPOCH }),
    })
    return response.status
  } catch (error) {
    console.error(`post failed: ${error.message}`)
    return 0
  }
}

async function checkSecurity() {
  const base = `http://127.0.0.1:${ready.port}/bridge`
  const body = JSON.stringify({ type: 'ping', epoch: EPOCH })
  const headers = { 'content-type': 'application/json' }
  try {
    const noToken = await fetch(base, { method: 'POST', headers, body })
    if (noToken.status !== 403) fail(`token check returned ${noToken.status}, expected 403`)
    const staleEpoch = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'x-dsh-float-token': ready.token },
      body: JSON.stringify({ type: 'ping', epoch: EPOCH - 1 }),
    })
    if (staleEpoch.status !== 409) fail(`epoch check returned ${staleEpoch.status}, expected 409`)
  } catch (error) {
    fail(`security check errored: ${error.message}`)
  }
}

const SAMPLE = '这是一条桥接自测回复，用来验证流式增量、结束帧与中止路径。'

function startStream(chatId) {
  const chat = { id: chatId, aborted: false, timer: null }
  chats.set(chatId, chat)
  let index = 0
  chat.timer = setInterval(() => {
    if (chat.aborted) {
      clearInterval(chat.timer)
      return
    }
    const text = SAMPLE.slice(index, index + 2)
    index += 2
    if (!text) {
      clearInterval(chat.timer)
      void post({ type: 'chat.done', id: chatId, text: SAMPLE, aborted: false })
      seen.completed = true
      return
    }
    void post({ type: 'chat.delta', id: chatId, seq: index, text })
  }, 25)
}

function handleRequest(frame) {
  const params = frame.params || {}
  switch (frame.method) {
    case 'models.list':
      respond(frame.id, true, {
        current: { provider: 'selftest', model: 'mock-chat' },
        providers: [
          {
            id: 'selftest',
            name: 'Self Test',
            models: [{ id: 'mock-chat', name: 'Mock Chat' }],
          },
        ],
      })
      return
    case 'config.get':
      respond(frame.id, true, { config: CONFIG, history: [] })
      return
    case 'config.set':
      respond(frame.id, true, { config: { ...CONFIG, ...params } })
      return
    case 'history.clear':
      respond(frame.id, true, { ok: true })
      return
    case 'chat.send': {
      const chatId = `chat-${++chatCounter}`
      respond(frame.id, true, {
        chatId,
        route: { provider: 'selftest', model: 'mock-chat' },
        switched: false,
        image: Boolean(params.imagePath),
      })
      startStream(chatId)
      return
    }
    case 'chat.abort': {
      const chat = chats.get(String(params.chatId || ''))
      if (chat && !chat.aborted) {
        chat.aborted = true
        clearInterval(chat.timer)
        seen.aborted = true
        void post({ type: 'chat.done', id: chat.id, text: '', aborted: true })
      }
      respond(frame.id, true, { aborted: Boolean(chat) })
      return
    }
    case 'helper.quit':
      respond(frame.id, true, { ok: true })
      return
    default:
      respond(frame.id, false, undefined, {
        code: 'UNKNOWN_METHOD',
        message: `mock host does not implement ${frame.method}`,
      })
  }
}

function onFrame(frame) {
  if (!frame || typeof frame !== 'object') return
  if (frame.type === 'ready') {
    if (ready) return
    ready = { port: Number(frame.port), token: String(frame.token) }
    console.log(`ready on 127.0.0.1:${ready.port} (epoch ${EPOCH})`)
    void checkSecurity()
    return
  }
  if (frame.type === 'log') {
    console.log(`helper log: ${frame.message}`)
    return
  }
  if (frame.type === 'req') handleRequest(frame)
}

function onLine(line) {
  if (!line.startsWith(PREFIX)) return
  try {
    onFrame(JSON.parse(line.slice(PREFIX.length)))
  } catch {
    /* ignore malformed frames */
  }
}

let buffer = ''
function onData(chunk) {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    onLine(line)
  }
}

console.log(`spawning ${ELECTRON}`)
child = spawn(ELECTRON, [HELPER, '--selftest'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', onData)
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text) console.log(text)
})
child.once('error', (error) => fail(`spawn failed: ${error.message}`))
child.once('exit', (code, signal) => {
  if (finished) return
  child = null
  if (code !== 0) return fail(`helper exited with code ${code}, signal ${signal}`)
  if (!seen.aborted) return fail('abort path was not exercised')
  if (!seen.completed) return fail('stream completion was not seen')
  done(0, 'PASS: bridge, streaming, abort and shutdown all behaved.')
})

process.on('SIGINT', () => fail('interrupted'))
