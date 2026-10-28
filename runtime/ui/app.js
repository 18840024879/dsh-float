'use strict'

const api = window.float

const els = {
  panel: document.getElementById('panel'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  chips: document.querySelector('.chips'),
  input: document.getElementById('input'),
  composer: document.getElementById('composer'),
  send: document.getElementById('sendButton'),
  stop: document.getElementById('stopButton'),
  shot: document.getElementById('shotButton'),
  attachment: document.getElementById('attachment'),
  attachmentImage: document.getElementById('attachmentImage'),
  removeShot: document.getElementById('removeShot'),
  modelButton: document.getElementById('modelButton'),
  modelLabel: document.getElementById('modelLabel'),
  modelSheet: document.getElementById('modelSheet'),
  modelList: document.getElementById('modelList'),
  closeSheet: document.getElementById('closeSheet'),
  newChat: document.getElementById('newChatBtn'),
  collapse: document.getElementById('collapseBtn'),
  toast: document.getElementById('toast'),
  hotkeyHint: document.getElementById('hotkeyHint'),
  grips: Array.from(document.querySelectorAll('.resize-handle')),
}

const MAX_VISIBLE_HISTORY = 12

const state = {
  config: null,
  catalog: null,
  history: [],
  chat: null,
  sending: false,
  pendingShot: null,
  toastTimer: null,
  sheetOpen: false,
  resize: null,
}

async function call(method, params) {
  const result = await api.request(method, params)
  if (!result || !result.ok) {
    const error = new Error(result?.error?.message || 'dsh 没有响应')
    error.code = result?.error?.code || 'REQUEST_FAILED'
    throw error
  }
  return result.data
}

function friendly(error) {
  const code = error?.code || ''
  if (code === 'TIMEOUT') return 'dsh 主程序响应超时，请确认它仍在运行。'
  if (code === 'BUSY') return '上一条回答还没结束。'
  if (code === 'MODEL_MISSING') return '还没有可用模型，请先在 dsh 里配置。'
  if (code === 'VISION_UNAVAILABLE') return error.message
  return error?.message || '操作失败'
}

/* ---------- view ---------- */

function focusPanel() {
  requestAnimationFrame(() => {
    els.input.focus()
    scrollToBottom(true)
  })
}

function showToast(message, ms = 3200) {
  if (!message) return
  els.toast.textContent = message
  els.toast.hidden = false
  if (state.toastTimer) clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => {
    state.toastTimer = null
    els.toast.hidden = true
  }, ms)
}

/* ---------- messages ---------- */

function clearMessages() {
  els.messages.replaceChildren(els.empty)
  els.empty.hidden = false
}

function renderAssistant(body, text) {
  if (typeof window.dshRenderRich === 'function') window.dshRenderRich(body, text)
  else body.textContent = text || ''
}

// Streaming re-renders parse every formula on the way in, so coalesce deltas
// into ~12 fps instead of re-rendering per chunk.
function scheduleRender(chat) {
  if (chat.renderTimer) return
  chat.renderTimer = setTimeout(() => {
    chat.renderTimer = null
    if (state.chat !== chat) return
    renderAssistant(chat.body, chat.text)
    scrollToBottom()
  }, 80)
}

function cancelRender(chat) {
  if (!chat || !chat.renderTimer) return
  clearTimeout(chat.renderTimer)
  chat.renderTimer = null
}

function addMessage(role, text, options = {}) {
  els.empty.hidden = true
  const wrap = document.createElement('div')
  wrap.className = `message ${role}${options.error ? ' error' : ''}`
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  if (options.image) {
    const img = document.createElement('img')
    img.className = 'bubble-image'
    img.src = options.image
    img.alt = '截图'
    bubble.appendChild(img)
  }
  const body = document.createElement('div')
  body.className = 'bubble-text'
  if (role === 'assistant') renderAssistant(body, text)
  else body.textContent = text || ''
  bubble.appendChild(body)
  wrap.appendChild(bubble)
  els.messages.appendChild(wrap)
  scrollToBottom()
  return { wrap, bubble, body }
}

function renderHistory() {
  clearMessages()
  const tail = state.history.slice(-MAX_VISIBLE_HISTORY)
  for (const entry of tail) {
    if (!entry || !entry.text) continue
    addMessage(entry.role === 'user' ? 'user' : 'assistant', entry.text, entry.image ? { image: entry.image } : {})
  }
  if (tail.length === 0) els.empty.hidden = false
  scrollToBottom(true)
}

function scrollToBottom(force = false) {
  const box = els.messages
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90
  if (force || nearBottom) box.scrollTop = box.scrollHeight
}

function appendMeta(wrap, text) {
  const meta = document.createElement('span')
  meta.className = 'message-meta'
  meta.textContent = text
  wrap.appendChild(meta)
}

/* ---------- sending ---------- */

function syncSendState() {
  const hasPayload = Boolean(els.input.value.trim() || state.pendingShot)
  els.send.disabled = state.sending || !hasPayload
}

function setSending(value) {
  state.sending = value
  els.stop.hidden = !value
  els.shot.disabled = value
  syncSendState()
}

async function send() {
  if (state.sending) return
  const text = els.input.value.trim()
  const shot = state.pendingShot
  if (!text && !shot) {
    els.input.focus()
    return
  }
  els.input.value = ''
  autosize()
  clearPendingShot()
  setSending(true)
  addMessage('user', text || '（截图）', shot ? { image: shot.dataUrl } : {})
  const assistant = addMessage('assistant', '', {})
  assistant.body.classList.add('typing')
  state.chat = { id: null, wrap: assistant.wrap, body: assistant.body, text: '', abortRequested: false }

  try {
    const ack = await call('chat.send', {
      text,
      imagePath: shot ? shot.path : null,
      imagePreview: shot ? shot.preview : null,
    })
    if (!state.chat) return
    state.chat.id = String(ack.chatId)
    if (ack.switched && ack.route) {
      showToast(`已自动切换到视觉模型 ${ack.route.provider}/${ack.route.model}`, 4200)
    }
    if (state.chat.abortRequested) {
      call('chat.abort', { chatId: state.chat.id }).catch(() => {})
    }
  } catch (error) {
    const chat = state.chat
    state.chat = null
    if (chat) {
      chat.body.classList.remove('typing')
      chat.wrap.classList.add('error')
      chat.body.textContent = friendly(error)
    }
    setSending(false)
    showToast(friendly(error))
    els.input.focus()
  }
}

async function stop() {
  const chat = state.chat
  if (!chat) return
  chat.abortRequested = true
  if (!chat.id) return
  try {
    await call('chat.abort', { chatId: chat.id })
  } catch (error) {
    showToast(friendly(error))
  }
}

function onDelta(frame) {
  const chat = state.chat
  if (!chat) return
  if (chat.id && String(frame.id) !== chat.id) return
  chat.text += String(frame.text || '')
  chat.body.classList.remove('typing')
  scheduleRender(chat)
  scrollToBottom()
}

function onDone(frame) {
  const chat = state.chat
  if (!chat) return
  if (chat.id && String(frame.id) !== chat.id) return
  state.chat = null
  cancelRender(chat)
  chat.body.classList.remove('typing')
  if (frame.error && !frame.aborted) {
    chat.wrap.classList.add('error')
    chat.body.textContent = frame.error.message || '回答失败。'
  } else {
    const finalText = String(frame.text || chat.text || '')
    chat.text = finalText
    if (finalText) {
      renderAssistant(chat.body, finalText)
      if (frame.aborted) appendMeta(chat.wrap, '已停止')
    } else {
      chat.body.textContent = frame.aborted ? '已停止。' : '（没有返回内容）'
    }
    scrollToBottom(true)
  }
  setSending(false)
  els.input.focus()
}

/* ---------- attachment ---------- */

// The host deletes the temp PNG after a successful send, so keep a small JPEG
// copy in history; the panel then shows the screenshot inside the user's message.
function makePreview(dataUrl, maxEdge = 720) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
        const context = canvas.getContext('2d')
        context.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function attachShot(frame) {
  if (!frame?.path || !frame?.dataUrl) return
  state.pendingShot = { path: frame.path, dataUrl: frame.dataUrl, preview: null }
  els.attachmentImage.src = frame.dataUrl
  els.attachment.hidden = false
  syncSendState()
  els.input.focus()
  void makePreview(frame.dataUrl).then((preview) => {
    if (state.pendingShot && state.pendingShot.path === frame.path) state.pendingShot.preview = preview
  })
}

function clearPendingShot() {
  state.pendingShot = null
  els.attachment.hidden = true
  els.attachmentImage.removeAttribute('src')
  syncSendState()
}

/* ---------- models ---------- */

async function loadModels() {
  try {
    state.catalog = await call('models.list')
    updateModelLabel()
    return true
  } catch (error) {
    showToast(`模型列表不可用：${friendly(error)}`)
    return false
  }
}

function currentRoute() {
  if (state.config?.model) return state.config.model
  return state.catalog?.current || null
}

function updateModelLabel() {
  const route = currentRoute()
  if (route) {
    els.modelLabel.textContent = route.model
    els.modelButton.title = `${route.provider} / ${route.model}`
  } else {
    els.modelLabel.textContent = '选择模型'
    els.modelButton.title = '选择模型'
  }
}

function modelOption(label, value, selected, detail) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `model-option${selected ? ' selected' : ''}`
  const name = document.createElement('span')
  name.textContent = label
  button.appendChild(name)
  if (detail) {
    const small = document.createElement('small')
    small.textContent = detail
    button.appendChild(small)
  }
  if (selected) {
    const tick = document.createElement('span')
    tick.className = 'tick'
    tick.textContent = '✓'
    button.appendChild(tick)
  }
  button.addEventListener('click', () => void chooseModel(value))
  return button
}

function renderModelList() {
  els.modelList.replaceChildren()
  const selected = state.config?.model || null
  els.modelList.appendChild(
    modelOption('跟随 dsh 默认', null, !selected, state.catalog?.current?.model || ''),
  )
  const providers = state.catalog?.providers || []
  let count = 0
  for (const provider of providers) {
    if (!provider || !Array.isArray(provider.models) || provider.models.length === 0) continue
    const group = document.createElement('div')
    group.className = 'model-group'
    group.textContent = provider.name || provider.id
    els.modelList.appendChild(group)
    for (const model of provider.models) {
      const value = { provider: provider.id, model: model.id }
      const isSelected = Boolean(selected && selected.provider === value.provider && selected.model === value.model)
      els.modelList.appendChild(modelOption(model.name || model.id, value, isSelected, model.id))
      count += 1
    }
  }
  if (count === 0) {
    const empty = document.createElement('div')
    empty.className = 'model-empty'
    empty.textContent = '没有读取到可用模型。请先在 dsh 里配置模型后重试。'
    els.modelList.appendChild(empty)
  }
}

async function chooseModel(value) {
  try {
    const data = await call('config.set', { model: value })
    state.config.model = data.config?.model ?? value
    updateModelLabel()
    closeSheet()
    showToast(value ? `已切换到 ${value.provider}/${value.model}` : '已跟随 dsh 默认模型')
  } catch (error) {
    showToast(friendly(error))
  }
}

async function openSheet() {
  if (!state.catalog) {
    const ok = await loadModels()
    if (!ok) return
  }
  renderModelList()
  els.modelSheet.hidden = false
  state.sheetOpen = true
}

function closeSheet() {
  if (els.modelSheet.hidden) return
  els.modelSheet.hidden = true
  state.sheetOpen = false
}

/* ---------- new chat ---------- */

async function startNewChat() {
  if (state.sending) {
    showToast('请先等这条回答结束，或点停止。')
    return
  }
  try {
    await call('history.clear')
    state.history = []
    clearMessages()
    clearPendingShot()
    scrollToBottom(true)
    showToast('已开始新对话')
  } catch (error) {
    showToast(friendly(error))
  }
}

/* ---------- input ---------- */

function autosize() {
  els.input.style.height = 'auto'
  els.input.style.height = `${Math.min(96, els.input.scrollHeight || 24)}px`
}

function collapseOrClear() {
  if (state.sheetOpen) {
    closeSheet()
    return
  }
  if (state.pendingShot) {
    clearPendingShot()
    return
  }
  void api.hide()
}

/* ---------- events from the helper ---------- */

function handleEvent(frame) {
  if (!frame || typeof frame !== 'object') return
  switch (frame.type) {
    case 'init':
      els.hotkeyHint.textContent = frame.hotkey ? `${frame.hotkey} 切换` : ''
      break
    case 'view':
      if (frame.view === 'panel') focusPanel()
      break
    case 'toast':
      showToast(frame.message)
      break
    case 'shot':
      attachShot(frame)
      break
    case 'chat.delta':
      onDelta(frame)
      break
    case 'chat.done':
      onDone(frame)
      break
    default:
      break
  }
}

/* ---------- wiring ---------- */

api.onEvent(handleEvent)

function startResize(event) {
  if (event.button !== 0) return
  event.preventDefault()
  const drag = { x: event.screenX, y: event.screenY, id: event.pointerId }
  try {
    event.currentTarget.setPointerCapture(event.pointerId)
  } catch {
    /* capture is best effort */
  }
  state.resize = drag
}

function moveResize(event) {
  const drag = state.resize
  if (!drag || event.pointerId !== drag.id) return
  let dx = event.screenX - drag.x
  let dy = event.screenY - drag.y
  if (!dx && !dy) return
  drag.x = event.screenX
  drag.y = event.screenY
  const mode = event.currentTarget.dataset.resize
  if (mode === 'e') dy = 0
  if (mode === 's') dx = 0
  void api.resizeBy(dx, dy)
}

function endResize(event) {
  if (!state.resize) return
  const { id } = state.resize
  state.resize = null
  try {
    event.currentTarget.releasePointerCapture(id)
  } catch {
    /* ignore */
  }
}

for (const grip of els.grips) {
  grip.addEventListener('pointerdown', startResize)
  grip.addEventListener('pointermove', moveResize)
  grip.addEventListener('pointerup', endResize)
  grip.addEventListener('pointercancel', endResize)
}

els.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void send()
})

els.input.addEventListener('input', () => {
  autosize()
  syncSendState()
})

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    collapseOrClear()
  }
})

els.stop.addEventListener('click', () => void stop())
els.shot.addEventListener('pointerenter', () => api.prewarmCapture?.())
els.shot.addEventListener('pointerleave', () => api.stopCapturePrewarm?.())
els.shot.addEventListener('click', () => void api.capture())
els.collapse.addEventListener('click', () => void api.hide())
els.newChat.addEventListener('click', () => void startNewChat())
els.removeShot.addEventListener('click', () => clearPendingShot())
els.modelButton.addEventListener('click', () => void openSheet())
els.closeSheet.addEventListener('click', () => closeSheet())

els.chips.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-prompt]')
  if (!button) return
  els.input.value = button.dataset.prompt || ''
  autosize()
  syncSendState()
  els.input.focus()
})

/* ---------- boot ---------- */

async function boot() {
  autosize()
  syncSendState()
  try {
    const data = await call('config.get')
    state.config = data.config || {}
    state.history = Array.isArray(data.history) ? data.history : []
    renderHistory()
    updateModelLabel()
  } catch (error) {
    showToast(`无法连接 dsh：${friendly(error)}`, 6000)
  }
  await loadModels()
}

void boot()
