import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const DATA_DIR = join(HOME, 'dsh-float')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const HISTORY_FILE = join(DATA_DIR, 'history.json')

export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个常驻桌面的 AI 助手，用户在任意应用上方随手召唤你。',
  '回答简洁、直接、可执行；不确定的信息要明说，不要编造。',
  '需要代码时给出最小可运行片段。',
].join('\n')

export const DEFAULT_CONFIG = {
  hotkey: 'Alt+Space',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  /** null = follow the dsh session default model. */
  model: null,
  maxHistoryRounds: 8,
  /** Automatically retry a screenshot request on a modlens vision route. */
  autoVision: true,
  opacity: 1,
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value
  } catch {
    return fallback
  }
}

export function loadConfig() {
  const raw = readJson(CONFIG_FILE, {})
  const config = { ...DEFAULT_CONFIG }
  if (raw && typeof raw === 'object') {
    if (typeof raw.hotkey === 'string' && raw.hotkey.trim()) config.hotkey = raw.hotkey.trim()
    if (typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()) config.systemPrompt = raw.systemPrompt
    if (raw.model && typeof raw.model.provider === 'string' && typeof raw.model.model === 'string') {
      config.model = { provider: raw.model.provider, model: raw.model.model }
    }
    if (Number.isFinite(raw.maxHistoryRounds)) {
      config.maxHistoryRounds = Math.min(50, Math.max(0, Math.trunc(raw.maxHistoryRounds)))
    }
    if (typeof raw.autoVision === 'boolean') config.autoVision = raw.autoVision
    if (Number.isFinite(raw.opacity)) config.opacity = Math.min(1, Math.max(0.2, raw.opacity))
  }
  return config
}

/** Write via tmp + rename so a crash never leaves a half-written JSON file. */
export function saveJson(file, value) {
  ensureDir()
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function saveConfig(config) {
  saveJson(CONFIG_FILE, config)
}

export function loadHistory() {
  const list = readJson(HISTORY_FILE, [])
  if (!Array.isArray(list)) return []
  return list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-40)
}

export function saveHistory(list) {
  saveJson(HISTORY_FILE, list.slice(-40))
}
