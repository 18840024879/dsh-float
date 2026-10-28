'use strict'

const fs = require('node:fs')

/** Offline stand-in for the dsh host, used by `electron main.js --mock`. */

const state = {
  aborted: new Set(),
  history: [],
}

const MOCK_REPLY = [
  '这是悬浮窗的离线预览模式。',
  '真正的回答会来自 dsh 当前配置的模型：',
  '在插件安装完成后，双击一下桌宠直接提问即可。',
  '你还可以点左下角的相机按钮框选屏幕区域提问。',
].join('\n\n')

function stream(bridge, chatId, text) {
  const chunks = Array.from(text)
  let index = 0
  const timer = setInterval(() => {
    if (state.aborted.has(chatId)) {
      state.aborted.delete(chatId)
      clearInterval(timer)
      bridge.emitEvent({
        type: 'chat.done',
        id: chatId,
        text: '',
        aborted: true,
        error: { code: 'ABORTED', message: '已停止。' },
      })
      return
    }
    if (index >= chunks.length) {
      clearInterval(timer)
      state.history.push({ role: 'assistant', text })
      bridge.emitEvent({ type: 'chat.done', id: chatId, text, aborted: false })
      return
    }
    const take = Math.min(3, chunks.length - index)
    const delta = chunks.slice(index, index + take).join('')
    index += take
    bridge.emitEvent({ type: 'chat.delta', id: chatId, seq: index, text: delta })
  }, 35)
}

function respond(method, params, bridge) {
  if (method === 'models.list') {
    return Promise.resolve({
      current: { provider: 'mock', model: 'mock-chat' },
      providers: [
        {
          id: 'mock',
          name: 'Mock 提供方',
          models: [
            { id: 'mock-chat', name: 'Mock Chat' },
            { id: 'mock-vision (modlens vision)', name: 'Mock Vision' },
          ],
        },
      ],
    })
  }
  if (method === 'config.get') {
    return Promise.resolve({
      config: {
        hotkey: 'Alt+Space',
        systemPrompt: '',
        model: null,
        maxHistoryRounds: 8,
        autoVision: true,
        opacity: 1,
      },
      history: state.history.slice(-20),
    })
  }
  if (method === 'config.set') return Promise.resolve({ config: params })
  if (method === 'history.clear') {
    state.history.length = 0
    return Promise.resolve({ ok: true })
  }
  if (method === 'chat.send') {
    const chatId = `mock-${Date.now()}`
    const text = String(params?.text || '')
    const imagePath = typeof params?.imagePath === 'string' ? params.imagePath : null
    state.history.push({ role: 'user', text: text || '[截图]' })
    if (imagePath) {
      try {
        fs.unlinkSync(imagePath)
      } catch {
        /* preview mode best effort */
      }
    }
    setTimeout(() => stream(bridge, chatId, MOCK_REPLY), 120)
    return Promise.resolve({
      chatId,
      route: { provider: 'mock', model: 'mock-chat' },
      switched: false,
      image: Boolean(params?.imagePath),
    })
  }
  if (method === 'chat.abort') {
    state.aborted.add(String(params?.chatId || ''))
    return Promise.resolve({ aborted: true })
  }
  if (method === 'helper.quit') {
    setTimeout(() => process.exit(0), 50)
    return Promise.resolve({ ok: true })
  }
  return Promise.reject(Object.assign(new Error(`mock: unknown method ${method}`), { code: 'UNKNOWN_METHOD' }))
}

module.exports = { respond }
