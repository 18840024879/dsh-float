'use strict'

/*
 * Renders model answers: LaTeX ($...$, $$...$$, \(...\), \[...\]) through
 * KaTeX's HTML output with the bundled KaTeX fonts (the same Computer Modern
 * look Doubao uses; its inline styles are why the CSP allows inline styles),
 * plus the markdown the model actually emits: headings, lists, tables, rules,
 * quotes, code fences, bold and inline code. Text is always built as DOM
 * nodes; only KaTeX's own escaped markup goes through innerHTML.
 */

const katex = window.katex || null
const formulaCache = new Map()

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/
const NUMBERED = /^(\s*)(\d{1,3})[.)][ \t]+(.*)$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/

function formulaHtml(tex, display) {
  if (!katex) return null
  const key = (display ? 'd:' : 'i:') + tex
  if (formulaCache.has(key)) return formulaCache.get(key)
  let html = null
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: 'html',
      throwOnError: true,
      strict: 'ignore',
      trust: false,
    })
  } catch {
    html = null
  }
  if (html !== null) {
    if (formulaCache.size > 256) formulaCache.clear()
    formulaCache.set(key, html)
  }
  return html
}

function appendMath(target, tex, display, raw) {
  const html = formulaHtml(tex, display)
  if (html === null) {
    target.appendChild(document.createTextNode(raw))
    return
  }
  const holder = document.createElement(display ? 'div' : 'span')
  holder.className = display ? 'math-block' : 'math-inline'
  holder.innerHTML = html
  target.appendChild(holder)
}

function looksLikeMath(body) {
  if (!body || body.length > 600) return false
  if (body.includes('\n')) return false
  if (/^\s|\s$/.test(body)) return false
  if (/^[0-9][0-9,.]*$/.test(body)) return false
  // Bare fractions like 1/4 carry math meaning, while "5/" from a currency
  // range does not; require both sides of every slash to be numbers.
  if (/^[0-9][0-9,.]*(\/[0-9][0-9,.]*)+$/.test(body)) return true
  return /[\\^_{}=+\-<>A-Za-z]/.test(body)
}

function isEscaped(source, index) {
  let count = 0
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) count += 1
  return count % 2 === 1
}

function findInlineClose(source, from) {
  for (let i = from; i < source.length; i++) {
    if (source[i] === '$' && !isEscaped(source, i)) return i
  }
  return -1
}

function findBracketClose(source, from, closeChar) {
  for (let i = from; i < source.length; i++) {
    if (source[i] === closeChar && source[i - 1] === '\\' && !isEscaped(source, i - 1)) return i - 1
  }
  return -1
}

/** Inline pass: math, inline code and bold inside one line or paragraph. */
function renderInline(container, text) {
  const source = String(text)
  let buffer = ''
  let i = 0
  const flush = () => {
    if (!buffer) return
    container.appendChild(document.createTextNode(buffer))
    buffer = ''
  }

  while (i < source.length) {
    const ch = source[i]

    if (ch === '`') {
      const close = source.indexOf('`', i + 1)
      if (close > i + 1) {
        flush()
        const code = document.createElement('code')
        code.textContent = source.slice(i + 1, close)
        container.appendChild(code)
        i = close + 1
        continue
      }
    }

    if (ch === '*' && source[i + 1] === '*') {
      const close = source.indexOf('**', i + 2)
      if (close > i + 2) {
        flush()
        const strong = document.createElement('strong')
        renderInline(strong, source.slice(i + 2, close))
        container.appendChild(strong)
        i = close + 2
        continue
      }
    }

    if (ch === '\\' && source[i + 1] === '(') {
      const close = findBracketClose(source, i + 2, ')')
      if (close > i + 2) {
        flush()
        appendMath(container, source.slice(i + 2, close), false, source.slice(i, close + 2))
        i = close + 2
        continue
      }
    }

    if (ch === '$' && !isEscaped(source, i)) {
      if (source[i + 1] === '$') {
        // Unclosed display math left over from streaming stays literal.
        buffer += '$$'
        i += 2
        continue
      }
      const close = findInlineClose(source, i + 1)
      const tex = close > i + 1 ? source.slice(i + 1, close) : ''
      if (tex && looksLikeMath(tex)) {
        flush()
        appendMath(container, tex, false, source.slice(i, close + 1))
        i = close + 1
        continue
      }
    }

    buffer += ch
    i += 1
  }
  flush()
}

function indentLevel(spaces) {
  return Math.min(3, Math.floor(spaces.length / 2))
}

function isTableSeparator(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false
  if (!/^\|?[\s:|-]+\|?$/.test(trimmed)) return false
  return trimmed.replace(/[|\s:-]/g, '').length === 0
}

function splitTableRow(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map((cell) => cell.trim())
}

function appendTable(target, lines, start) {
  const headers = splitTableRow(lines[start])
  const wrap = document.createElement('div')
  wrap.className = 'md-table-wrap'
  const table = document.createElement('table')
  table.className = 'md-table'

  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const cell of headers) {
    const th = document.createElement('th')
    renderInline(th, cell)
    headRow.appendChild(th)
  }
  head.appendChild(headRow)
  table.appendChild(head)

  const body = document.createElement('tbody')
  let index = start + 2
  while (index < lines.length && TABLE_ROW.test(lines[index].replace(/\s+$/, ''))) {
    const cells = splitTableRow(lines[index])
    const row = document.createElement('tr')
    for (let column = 0; column < headers.length; column += 1) {
      const td = document.createElement('td')
      renderInline(td, cells[column] || '')
      row.appendChild(td)
    }
    body.appendChild(row)
    index += 1
  }
  table.appendChild(body)
  wrap.appendChild(table)
  target.appendChild(wrap)
  return index - 1
}

/** Block pass: one text run between fences/display math becomes headings, lists, paragraphs. */
function renderTextBlocks(target, text) {
  const lines = String(text).split('\n')
  let paragraph = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const content = paragraph.join('\n').replace(/\n+$/, '')
    paragraph = []
    if (!content.trim()) return
    const block = document.createElement('div')
    block.className = 'md-p'
    renderInline(block, content)
    target.appendChild(block)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+$/, '')
    if (!line.trim()) {
      flushParagraph()
      continue
    }

    if (TABLE_ROW.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph()
      index = appendTable(target, lines, index)
      continue
    }

    let match = HEADING.exec(line)
    if (match) {
      flushParagraph()
      const level = Math.min(match[1].length, 3)
      const block = document.createElement('div')
      block.className = `md-heading md-h${level}`
      renderInline(block, match[2].replace(/[ \t]+#+[ \t]*$/, ''))
      target.appendChild(block)
      continue
    }

    if (RULE.test(line)) {
      flushParagraph()
      const rule = document.createElement('hr')
      rule.className = 'md-hr'
      target.appendChild(rule)
      continue
    }

    match = BULLET.exec(line)
    if (match) {
      flushParagraph()
      const block = document.createElement('div')
      block.className = `md-li md-li-${indentLevel(match[1])}`
      const bullet = document.createElement('span')
      bullet.className = 'md-bullet'
      bullet.textContent = '•'
      block.appendChild(bullet)
      renderInline(block, match[2])
      target.appendChild(block)
      continue
    }

    match = NUMBERED.exec(line)
    if (match) {
      flushParagraph()
      const block = document.createElement('div')
      block.className = `md-li md-li-${indentLevel(match[1])}`
      const number = document.createElement('span')
      number.className = 'md-bullet'
      number.textContent = `${match[2]}.`
      block.appendChild(number)
      renderInline(block, match[3])
      target.appendChild(block)
      continue
    }

    match = QUOTE.exec(line)
    if (match) {
      flushParagraph()
      const block = document.createElement('div')
      block.className = 'md-quote'
      renderInline(block, match[1])
      target.appendChild(block)
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()
}

function renderRich(target, text) {
  const source = String(text == null ? '' : text)
  target.replaceChildren()
  if (!katex) {
    target.textContent = source
    return
  }

  let textStart = 0
  let cursor = 0
  const flushText = (end) => {
    if (end <= textStart) return
    renderTextBlocks(target, source.slice(textStart, end))
  }

  while (cursor < source.length) {
    const ch = source[cursor]

    if (ch === '`' && source[cursor + 1] === '`' && source[cursor + 2] === '`') {
      const close = source.indexOf('```', cursor + 3)
      if (close < 0) break
      flushText(cursor)
      let body = source.slice(cursor + 3, close)
      // Only an opening fence with text on its own line carries a language tag;
      // "```\n第一行" starts the code right away, so never drop that line.
      if (body.startsWith('\n')) {
        body = body.slice(1)
      } else {
        const firstLine = body.split('\n', 1)[0]
        if (firstLine && /^[A-Za-z0-9+#._-]+$/.test(firstLine) && body.length > firstLine.length) {
          body = body.slice(firstLine.length + 1)
        }
      }
      if (body.endsWith('\n')) body = body.slice(0, -1)
      const pre = document.createElement('pre')
      pre.className = 'code-block'
      const code = document.createElement('code')
      code.textContent = body
      pre.appendChild(code)
      target.appendChild(pre)
      textStart = source[close + 3] === '\n' ? close + 4 : close + 3
      cursor = textStart
      continue
    }

    let display = false
    let texStart = -1
    let texEnd = -1
    let rawEnd = -1

    if (ch === '\\' && source[cursor + 1] === '[') {
      const close = findBracketClose(source, cursor + 2, ']')
      if (close < 0) break
      display = true
      texStart = cursor + 2
      texEnd = close
      rawEnd = close + 2
    } else if (ch === '$' && source[cursor + 1] === '$' && !isEscaped(source, cursor)) {
      const close = source.indexOf('$$', cursor + 2)
      if (close < 0) break
      display = true
      texStart = cursor + 2
      texEnd = close
      rawEnd = close + 2
    }

    if (texStart < 0) {
      cursor += 1
      continue
    }

    flushText(cursor)
    appendMath(target, source.slice(texStart, texEnd), display, source.slice(cursor, rawEnd))
    textStart = rawEnd
    cursor = rawEnd
  }

  flushText(source.length)
}

window.dshRenderRich = renderRich
