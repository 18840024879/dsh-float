'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEBUG_LOG = path.join(os.homedir(), '.dsh', 'dsh-float', 'helper-debug.log')
const MAX_LOG_BYTES = 256 * 1024

function debug(message) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true })
    try {
      if (fs.statSync(DEBUG_LOG).size > MAX_LOG_BYTES) fs.writeFileSync(DEBUG_LOG, '')
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* diagnostics must never break the helper */
  }
}

module.exports = { debug }
