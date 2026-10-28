'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const listeners = new Set()
ipcRenderer.on('float:event', (_event, frame) => {
  for (const listener of listeners) {
    try {
      listener(frame)
    } catch {
      /* a renderer callback must not break the channel */
    }
  }
})

contextBridge.exposeInMainWorld('float', {
  request(method, params) {
    return ipcRenderer.invoke('float:request', { method, params })
  },
  capture() {
    return ipcRenderer.invoke('float:capture')
  },
  prewarmCapture() {
    ipcRenderer.send('float:capture-prewarm')
  },
  stopCapturePrewarm() {
    ipcRenderer.send('float:capture-stop-prewarm')
  },
  resizeBy(dx, dy) {
    return ipcRenderer.invoke('float:resize-by', { dx, dy })
  },
  hide() {
    return ipcRenderer.invoke('float:hide')
  },
  quit() {
    return ipcRenderer.invoke('float:quit')
  },
  onEvent(callback) {
    listeners.add(callback)
    return () => listeners.delete(callback)
  },
})
