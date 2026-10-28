export const BRIDGE_PREFIX = 'dsh-float-bridge:'
export const MAX_LINE_BYTES = 1024 * 1024

/**
 * Incremental newline framing over the helper's stdout. Only lines carrying the
 * bridge prefix are protocol frames; Electron's own console output is ignored.
 * An unterminated line over max is dropped whole so a runaway writer cannot grow
 * the buffer without bound.
 */
export function createLineBuffer(onFrame, max = MAX_LINE_BYTES) {
  let buffer = ''
  let discarding = false

  return {
    push(chunk) {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (discarding) {
          discarding = false
          continue
        }
        if (line.length === 0) continue
        if (!line.startsWith(BRIDGE_PREFIX)) continue
        let frame
        try {
          frame = JSON.parse(line.slice(BRIDGE_PREFIX.length))
        } catch {
          continue
        }
        if (!frame || typeof frame !== 'object') continue
        onFrame(frame)
      }
      if (buffer.length > max) {
        buffer = ''
        discarding = true
      }
    },
    reset() {
      buffer = ''
      discarding = false
    },
  }
}

export function encodeFrame(frame) {
  return BRIDGE_PREFIX + JSON.stringify(frame) + '\n'
}

export function isFreshEpoch(expected, actual) {
  return expected === undefined || expected === null || expected === actual
}
