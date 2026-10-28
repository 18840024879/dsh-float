'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const INBOUND = {
  capture: 'float:overlay-capture',
  data: 'float:overlay-data',
  paint: 'float:overlay-paint',
  prewarm: 'float:overlay-prewarm',
  stop: 'float:overlay-stop',
}

contextBridge.exposeInMainWorld('overlay', {
  on(name, callback) {
    const channel = INBOUND[name]
    if (!channel || typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  frame(payload) {
    ipcRenderer.send('float:overlay-frame', payload)
  },
  painted(payload) {
    ipcRenderer.send('float:overlay-painted', payload)
  },
  failed(payload) {
    ipcRenderer.send('float:overlay-failed', payload)
  },
  done(rect) {
    ipcRenderer.send('float:overlay-done', rect)
  },
  cancel() {
    ipcRenderer.send('float:overlay-cancel')
  },
})
