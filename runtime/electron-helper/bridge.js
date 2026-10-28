'use strict'

const { EventEmitter } = require('node:events')
const http = require('node:http')
const crypto = require('node:crypto')

const PREFIX = 'dsh-float-bridge:'
const MAX_BODY = 4 * 1024 * 1024
const REQUEST_TIMEOUT = 180_000

/**
 * Two channels, deliberately asymmetric:
 *   helper -> host : one JSON line per frame on stdout (Electron cannot read a
 *                    piped stdin on Windows, so the host never writes stdin)
 *   host -> helper : POSTs to a loopback server that only exists while this
 *                    helper is alive, guarded by a per-launch random token
 */
class Bridge extends EventEmitter {
  constructor({ epoch, mock = false }) {
    super()
    this.epoch = epoch
    this.mock = mock
    this.token = crypto.randomBytes(16).toString('hex')
    this.server = null
    this.port = 0
    this.seq = 0
    this.pending = new Map()
    this.closed = false
  }

  write(frame) {
    if (this.closed) return
    try {
      process.stdout.write(PREFIX + JSON.stringify({ ...frame, epoch: this.epoch }) + '\n')
    } catch {
      /* stdout is gone; the host-liveness guard handles shutdown */
    }
  }

  async start() {
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.server.on('clientError', (_error, socket) => {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = this.server.address().port
    this.write({
      type: 'ready',
      v: 1,
      port: this.port,
      pid: process.pid,
      token: this.token,
    })
    return this.port
  }

  handleHttp(req, res) {
    if (req.method !== 'POST' || req.url !== '/bridge') {
      res.writeHead(404).end()
      return
    }
    if (req.headers['x-dsh-float-token'] !== this.token) {
      res.writeHead(403).end()
      return
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        res.writeHead(413).end()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      let frame
      try {
        frame = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      if (!frame || typeof frame !== 'object' || frame.epoch !== this.epoch) {
        res.writeHead(409).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      if (frame.type === 'res') {
        const entry = this.pending.get(String(frame.id))
        if (!entry) return
        this.pending.delete(String(frame.id))
        clearTimeout(entry.timer)
        if (frame.ok) entry.resolve(frame.data)
        else {
          const error = new Error(frame.error?.message || 'request failed')
          error.code = frame.error?.code || 'REQUEST_FAILED'
          entry.reject(error)
        }
        return
      }
      this.emit('event', frame)
    })
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT) {
    if (this.mock) return require('./mock-host').respond(method, params, this)
    const id = String(++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`请求超时：${method}`)
        error.code = 'TIMEOUT'
        reject(error)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ type: 'req', id, method, params })
    })
  }

  /** Mock-mode event emitter used by ./mock-host while previewing offline. */
  emitEvent(frame) {
    this.emit('event', frame)
  }

  close() {
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(Object.assign(new Error('helper closing'), { code: 'CLOSED' }))
    }
    this.pending.clear()
    try {
      this.server?.close()
    } catch {
      /* ignore */
    }
  }
}

module.exports = { Bridge, PREFIX }
