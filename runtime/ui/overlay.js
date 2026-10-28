'use strict'

const shot = document.getElementById('shot')
const selection = document.getElementById('selection')
const size = document.getElementById('size')

let start = null
let current = null

let stream = null
let streamKey = ''
let starting = null
let startingKey = ''
let generation = 0
let video = null
let canvas = null
let context = null
let imageUrl = ''
let displayTask = null

const FRAME_WAIT = 3
const FRAME_TIMEOUT = 320
// The compositor needs a beat after the panel turns transparent; sampling the
// stream sooner returns frames that still contain it.
const MIN_HIDE_DELAY = 110

function rectFrom(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.abs(b.x - a.x)),
    height: Math.round(Math.abs(b.y - a.y)),
  }
}

function paint(rect) {
  selection.hidden = false
  selection.style.left = `${rect.x}px`
  selection.style.top = `${rect.y}px`
  selection.style.width = `${rect.width}px`
  selection.style.height = `${rect.height}px`
  size.textContent = `${rect.width} × ${rect.height}`
}

function resetSelection() {
  start = null
  current = null
  selection.hidden = true
  size.textContent = ''
}

function specKey(spec) {
  return [spec.displayId, spec.sourceId || '', spec.maxWidth, spec.maxHeight].join('|')
}

function stopStream() {
  generation += 1
  starting = null
  startingKey = ''
  streamKey = ''
  if (!stream) return
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      /* ignore */
    }
  }
  stream = null
  if (video) {
    video.srcObject = null
  }
}

function startStream(spec) {
  const key = specKey(spec)
  if (stream && streamKey === key) return Promise.resolve()
  if (starting && startingKey === key) return starting
  stopStream()

  const videoConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      maxWidth: spec.maxWidth,
      maxHeight: spec.maxHeight,
      maxFrameRate: 60,
    },
  }
  if (spec.sourceId) videoConstraints.mandatory.chromeMediaSourceId = spec.sourceId

  const current = generation
  startingKey = key
  starting = navigator.mediaDevices
    .getUserMedia({ audio: false, video: videoConstraints })
    .then((next) => {
      if (current !== generation) {
        for (const track of next.getTracks()) track.stop()
        throw new Error('屏幕流已取消')
      }
      stream = next
      streamKey = key
      if (!video) {
        video = document.createElement('video')
        video.muted = true
        video.playsInline = true
      }
      video.srcObject = next
      return video.play()
    })
    .then(() => {
      if (video.videoWidth > 0) return undefined
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('屏幕流没有画面')), 2000)
        video.addEventListener(
          'loadedmetadata',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    })
    .then(() => {
      const track = stream.getVideoTracks()[0]
      if (track) {
        track.addEventListener('ended', () => {
          if (stream && stream.getVideoTracks()[0] === track) stopStream()
        })
      }
    })
    .finally(() => {
      if (startingKey === key) {
        starting = null
        startingKey = ''
      }
    })
  return starting
}

function waitFrames(count) {
  return new Promise((resolve) => {
    if (!video || typeof video.requestVideoFrameCallback !== 'function') {
      setTimeout(resolve, FRAME_TIMEOUT)
      return
    }
    let remaining = count
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, FRAME_TIMEOUT)
    const step = () => {
      if (done) return
      video.requestVideoFrameCallback(() => {
        remaining -= 1
        if (remaining <= 0) finish()
        else step()
      })
    }
    step()
  })
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const onLoad = () => {
      shot.removeEventListener('error', onError)
      resolve()
    }
    const onError = () => {
      shot.removeEventListener('load', onLoad)
      reject(new Error('截图显示失败'))
    }
    shot.addEventListener('load', onLoad, { once: true })
    shot.addEventListener('error', onError, { once: true })
    shot.src = url
  })
}

async function showBlob(blob) {
  const url = URL.createObjectURL(blob)
  await loadImage(url)
  if (typeof shot.decode === 'function') await shot.decode().catch(() => {})
  if (imageUrl) URL.revokeObjectURL(imageUrl)
  imageUrl = url
}

async function showDataUrl(url) {
  await loadImage(url)
  if (typeof shot.decode === 'function') await shot.decode().catch(() => {})
  if (imageUrl) {
    URL.revokeObjectURL(imageUrl)
    imageUrl = ''
  }
}

async function captureStream(spec, id, startedAt) {
  await startStream(spec)
  resetSelection()
  // The float was hidden just before this command; two stale frames can still
  // be queued in the capture pipeline, so wait for fresh ones, then make sure
  // the panel has actually left the composited screen.
  await waitFrames(FRAME_WAIT)
  const remaining = MIN_HIDE_DELAY - (performance.now() - startedAt)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
  const waited = performance.now() - startedAt

  const vw = video.videoWidth
  const vh = video.videoHeight
  const scaleX = vw / spec.displayBounds.width
  const scaleY = vh / spec.displayBounds.height
  const expectedWidth = Math.round(spec.displayBounds.width * spec.scaleFactor)
  const expectedHeight = Math.round(spec.displayBounds.height * spec.scaleFactor)
  if (
    Math.abs(vw / expectedWidth - 1) > 0.1 ||
    Math.abs(vh / expectedHeight - 1) > 0.1
  ) {
    throw new Error('屏幕流来源不匹配')
  }

  const sx = Math.round((spec.workArea.x - spec.displayBounds.x) * scaleX)
  const sy = Math.round((spec.workArea.y - spec.displayBounds.y) * scaleY)
  const sw = Math.min(vw - sx, Math.round(spec.workArea.width * scaleX))
  const sh = Math.min(vh - sy, Math.round(spec.workArea.height * scaleY))
  if (sw < 2 || sh < 2) throw new Error('屏幕流截取范围无效')

  if (!canvas) canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  if (!context) context = canvas.getContext('2d')
  context.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('截图编码失败')
  const buffer = new Uint8Array(await blob.arrayBuffer())
  const encoded = performance.now()

  await showBlob(blob)
  window.overlay.frame({
    id,
    buffer,
    ms: Math.round(performance.now() - startedAt),
    wait: Math.round(waited),
    encode: Math.round(encoded - startedAt - waited),
    display: Math.round(performance.now() - encoded),
  })
}

window.overlay.on('prewarm', (spec) => {
  if (!spec) return
  startStream(spec).catch(() => {
    /* capture will retry and fall back */
  })
})

window.overlay.on('stop', () => stopStream())

window.overlay.on('capture', (spec) => {
  if (!spec || spec.id == null) return
  const id = spec.id
  const startedAt = performance.now()
  const promise = captureStream(spec, id, startedAt)
  displayTask = { id, promise }
  promise.catch((error) => {
    window.overlay.failed({ id, message: String((error && error.message) || error) })
  })
})

window.overlay.on('data', (payload) => {
  if (!payload || !payload.image) return
  const id = payload.id
  const promise = (async () => {
    resetSelection()
    await showDataUrl(payload.image)
  })()
  displayTask = { id, promise }
  promise.catch((error) => {
    window.overlay.failed({ id, message: String((error && error.message) || error) })
  })
})

window.overlay.on('paint', (payload) => {
  const id = payload && payload.id
  const wait = displayTask && displayTask.id === id ? displayTask.promise.catch(() => {}) : Promise.resolve()
  void wait.then(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.overlay.painted({ id }))
    })
  })
})

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  start = { x: event.clientX, y: event.clientY }
  current = null
  paint({ x: start.x, y: start.y, width: 0, height: 0 })
  document.body.setPointerCapture?.(event.pointerId)
})

document.addEventListener('pointermove', (event) => {
  if (!start) return
  current = { x: event.clientX, y: event.clientY }
  paint(rectFrom(start, current))
})

document.addEventListener('pointerup', (event) => {
  if (!start || event.button !== 0) return
  const end = { x: event.clientX, y: event.clientY }
  const rect = rectFrom(start, end)
  start = null
  current = null
  if (rect.width >= 3 && rect.height >= 3) window.overlay.done(rect)
  else window.overlay.cancel()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.overlay.cancel()
})

document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.overlay.cancel()
})

window.addEventListener('beforeunload', () => stopStream())
