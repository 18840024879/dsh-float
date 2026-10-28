import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

/*
 * @deepseek-ai/dsh-llm ships inside app.asar and cannot be resolved from a
 * plugin directory, so mirror the tiny part of its contract we rely on:
 * identified messages and text assembly over the documented stream chunks.
 */
function createMessage(input) {
  return Object.freeze(structuredClone({ ...input, id: randomUUID() }))
}

function createUserMessage(input) {
  return createMessage({ ...input, role: 'user' })
}

function createAssistantMessage(input) {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: { kind: 'model', ...input.source },
  })
}

class TextAssembler {
  constructor() {
    this.partials = new Map()
    this.order = []
    this._finish = null
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', block: null }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  push(chunk) {
    switch (chunk?.type) {
      case 'block-start':
        this.ensure(chunk.index, chunk.blockType)
        return
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return
        partial.text += String(chunk.text ?? '')
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block?.type || 'text')
        if (!partial.block) partial.block = chunk.block
        return
      }
      case 'finish':
        this._finish = chunk.reason
        return
      default:
        return
    }
  }

  get finish() {
    return this._finish ?? { kind: 'stop' }
  }

  blocks() {
    return this.order.map((index) => {
      const partial = this.partials.get(index)
      if (partial.block) return partial.block
      if (partial.blockType === 'text' || partial.blockType === 'reasoning') {
        return { type: partial.blockType, text: partial.text }
      }
      return { type: partial.blockType }
    })
  }
}

export const SESSION_ID = 'dsh-float'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const SHOT_DIR = resolve(tmpdir(), 'dsh-float')

export function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function currentRoute(ctx, config) {
  if (config?.model?.provider && config.model.model) return { ...config.model }
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
  } catch {
    /* no session default yet */
  }
  return null
}

function providerList(ctx) {
  const llm = ctx.llm
  let list = []
  try {
    if (typeof llm?.listProviders === 'function') list = llm.listProviders()
  } catch {
    list = []
  }
  if (!Array.isArray(list) || list.length === 0) {
    try {
      if (typeof llm?.listConfigurableProviders === 'function') list = llm.listConfigurableProviders()
    } catch {
      list = []
    }
  }
  return (Array.isArray(list) ? list : [])
    .map((p) => ({
      id: String(p?.id ?? p?.provider ?? ''),
      name: String(p?.name ?? p?.displayName ?? p?.id ?? p?.provider ?? ''),
    }))
    .filter((p) => p.id)
}

export async function listCatalog(ctx, config) {
  const llm = ctx.llm
  const providers = providerList(ctx)
  const catalog = await Promise.all(
    providers.map(async (p) => {
      let models = []
      try {
        const raw = await llm?.listModels?.(p.id)
        models = (Array.isArray(raw) ? raw : [])
          .map((m) => ({ id: String(m?.id ?? ''), name: String(m?.name ?? m?.id ?? '') }))
          .filter((m) => m.id)
      } catch {
        models = []
      }
      return { ...p, models }
    }),
  )
  return { current: currentRoute(ctx, config), providers: catalog }
}

async function modelInfo(ctx, provider, model) {
  try {
    return await ctx.llm?.resolveModelInfo?.(provider, model)
  } catch {
    return undefined
  }
}

export async function isImageRoute(ctx, route) {
  if (!route) return false
  const info = await modelInfo(ctx, route.provider, route.model)
  if (!info) return undefined
  return Array.isArray(info.inputModalities) && info.inputModalities.includes('image')
}

/**
 * Text-only routes do not reject an image block; the harness silently projects
 * it to placeholder text. Find a vision-capable wrapper that serves the same
 * underlying model (modlens registers one per eligible route).
 */
async function findVisionRoute(ctx, wanted) {
  const providers = providerList(ctx)
  if (providers.length === 0) return null
  const looksModlens = (p) => /modlens/i.test(p.id) || /modlens/i.test(p.name)
  const ordered = [
    ...providers.filter(looksModlens),
    ...providers.filter((p) => !looksModlens(p)),
  ]
  for (const p of ordered) {
    let models = []
    try {
      const raw = await ctx.llm?.listModels?.(p.id)
      models = (Array.isArray(raw) ? raw : []).map((m) => ({ id: String(m?.id ?? ''), name: String(m?.name ?? '') }))
    } catch {
      continue
    }
    for (const m of models) {
      if (!m.id) continue
      const sameModel = m.id === wanted.model || m.id.includes(wanted.model)
      if (!sameModel) continue
      const info = await modelInfo(ctx, p.id, m.id)
      if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) {
        return { provider: p.id, model: m.id, name: m.name || m.id }
      }
    }
  }
  return null
}

export async function resolveRouteForRequest(ctx, config, options = {}) {
  const route = currentRoute(ctx, config)
  if (!route) throw fail('MODEL_MISSING', '当前没有可用模型，请先在 dsh 里配置模型。')
  if (!options.needsImage) return { route, switched: false }

  const capable = await isImageRoute(ctx, route)
  if (capable === true) return { route, switched: false }

  if (config?.autoVision !== false) {
    const vision = await findVisionRoute(ctx, route)
    if (vision) return { route, switched: true, vision }
  }

  throw fail(
    'VISION_UNAVAILABLE',
    `模型 ${route.provider}/${route.model} 不支持图片输入，也没有找到可用的视觉路由。请安装/启用 modlens，或在设置里选择 vision 模型。`,
  )
}

function sniffMediaType(bytes) {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 &&
      String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF' &&
      String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'GIF8') return 'image/gif'
  return null
}

/** Only trust screenshots this plugin wrote into its own temp directory. */
export function readScreenshot(imagePath) {
  if (typeof imagePath !== 'string' || imagePath.length === 0) throw fail('IMAGE_INVALID', '截图路径为空。')
  const full = resolve(imagePath)
  if (!full.startsWith(SHOT_DIR + sep)) throw fail('IMAGE_INVALID', '截图路径不在允许的临时目录内。')
  if (!/^shot-[A-Za-z0-9._-]+$/.test(basename(full))) throw fail('IMAGE_INVALID', '截图文件名不合法。')
  if (!/\.(png|jpe?g|webp)$/i.test(extname(full))) throw fail('IMAGE_INVALID', '截图格式不支持。')
  if (!existsSync(full)) throw fail('IMAGE_INVALID', '截图文件不存在。')
  const stat = statSync(full)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
    throw fail('IMAGE_INVALID', '截图文件大小超出限制。')
  }
  const bytes = new Uint8Array(readFileSync(full))
  const mediaType = sniffMediaType(bytes)
  if (!mediaType) throw fail('IMAGE_INVALID', '无法识别的图片格式。')
  return { bytes, mediaType, path: full }
}

const PREVIEW_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const PREVIEW_MAX_CHARS = 400_000

/**
 * The panel keeps a small thumbnail in its history so a sent screenshot stays
 * visible after the temp file is deleted. Only accept an inline image the
 * renderer produced; anything else would bloat history.json or smuggle markup.
 */
export function sanitizePreview(value) {
  if (typeof value !== 'string' || value.length > PREVIEW_MAX_CHARS) return null
  return PREVIEW_DATA_URL.test(value) ? value : null
}

export function discardScreenshot(imagePath) {
  try {
    const full = resolve(imagePath)
    if (full.startsWith(SHOT_DIR + sep) && existsSync(full)) unlinkSync(full)
  } catch {
    /* best effort */
  }
}

function toHistoryMessages(history, route, rounds) {
  const keep = Number.isFinite(rounds) ? Math.max(0, rounds) : 8
  const slice = history.slice(-keep * 2)
  return slice.map((m) =>
    m.role === 'user'
      ? createUserMessage({ content: [{ type: 'text', text: m.text }], source: { kind: 'user' } })
      : createAssistantMessage({
          content: [{ type: 'text', text: m.text }],
          source: { provider: route.provider, model: route.model },
        }),
  )
}

/**
 * Stream one chat completion. Deltas are reported as they arrive; the returned
 * text is authoritative so the renderer can reconcile any dropped delta.
 */
export async function runChat(ctx, options) {
  const { route, history, text, imageRef, system, signal, maxHistoryRounds } = options
  if (typeof ctx.llm?.stream !== 'function') throw fail('LLM_UNAVAILABLE', 'LLM 服务不可用。')

  const prior = toHistoryMessages(history, route, maxHistoryRounds)
  const content = []
  if (text && text.trim()) content.push({ type: 'text', text })
  if (imageRef) content.push({ type: 'image', attachment: imageRef })
  if (content.length === 0) throw fail('EMPTY_INPUT', '消息为空。')
  const user = createUserMessage({ content, source: { kind: 'user' } })

  const assembler = new TextAssembler()
  let streamed = ''
  const streamOptions = {
    provider: route.provider,
    model: route.model,
    sessionId: SESSION_ID,
    messages: [...prior, user],
    temperature: 1,
    signal,
  }
  if (system && system.trim()) streamOptions.system = system

  for await (const chunk of ctx.llm.stream(streamOptions)) {
    assembler.push(chunk)
    if (chunk?.type === 'text-delta' && chunk.text) {
      streamed += chunk.text
      options.onDelta?.(chunk.text)
    } else if (chunk?.type === 'reasoning-delta' && chunk.text) {
      options.onReasoning?.(chunk.text)
    }
  }

  const textParts = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  const finish = assembler.finish
  if (!textParts) {
    const reason = finish?.kind === 'error'
      ? finish?.failure?.message || finish?.failure?.code || '模型返回了错误。'
      : '模型没有返回文本。'
    throw fail('EMPTY_REPLY', reason)
  }
  return { text: textParts, streamed, finish, route }
}
