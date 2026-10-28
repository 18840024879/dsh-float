'use strict'

const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { debug } = require('./debug')

const SOURCE = path.join(__dirname, '..', 'pet-watch', 'PetWatch.cs')
const DATA_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-float')
const BIN_DIR = path.join(DATA_ROOT, 'bin')

function compilerPath() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  return [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((file) => fs.existsSync(file)) || null
}

function build(onReady) {
  let source
  try {
    source = fs.readFileSync(SOURCE, 'utf8')
  } catch (error) {
    debug(`pet-watch source missing: ${error.message}`)
    onReady(null)
    return
  }

  const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10)
  const exe = path.join(BIN_DIR, `pet-watch-${hash}.exe`)
  if (fs.existsSync(exe)) {
    onReady(exe)
    return
  }

  const csc = compilerPath()
  if (!csc) {
    debug('pet-watch disabled: csc.exe not found')
    onReady(null)
    return
  }

  try {
    fs.mkdirSync(BIN_DIR, { recursive: true })
  } catch (error) {
    debug(`pet-watch bin dir failed: ${error.message}`)
    onReady(null)
    return
  }

  execFile(
    csc,
    ['/nologo', '/target:exe', '/optimize+', `/out:${exe}`, SOURCE],
    { windowsHide: true, timeout: 30_000 },
    (error, _stdout, stderr) => {
      if (error) {
        debug(`pet-watch compile failed: ${(stderr || error.message).trim()}`)
        try {
          fs.unlinkSync(exe)
        } catch {
          /* nothing to clean */
        }
        onReady(null)
        return
      }
      if (!fs.existsSync(exe)) {
        debug('pet-watch compile produced no exe')
        onReady(null)
        return
      }
      debug(`pet-watch compiled ${path.basename(exe)}`)
      onReady(exe)
    },
  )
}

/**
 * Runs a click watchdog for dsh-pet windows. Every click on the desktop pet
 * becomes a `pet.click` bridge frame, which main.js turns into a panel toggle.
 * The watcher exits by itself when this helper process disappears.
 */
function startPetWatch({ port, token, epoch, helperPid }) {
  let child = null
  let stopped = false

  build((exe) => {
    if (stopped || !exe) return
    try {
      child = spawn(exe, [], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          DSH_FLOAT_BRIDGE_PORT: String(port),
          DSH_FLOAT_BRIDGE_TOKEN: token,
          DSH_FLOAT_EPOCH: String(epoch),
          DSH_FLOAT_HELPER_PID: String(helperPid),
        },
      })
    } catch (error) {
      debug(`pet-watch spawn failed: ${error.message}`)
      return
    }
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) debug(`pet-watch: ${text}`)
    })
    child.on('error', (error) => debug(`pet-watch error: ${error.message}`))
    child.on('exit', (code) => debug(`pet-watch exited (${code})`))
    debug(`pet-watch started pid=${child.pid}`)
  })

  return {
    stop() {
      stopped = true
      if (!child) return
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      child = null
    },
  }
}

module.exports = { startPetWatch }
