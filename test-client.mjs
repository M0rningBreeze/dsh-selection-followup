/**
 * Offline test for the client half: no browser, no DSH runtime, no React
 * package (the web page supplies React from its module table, so this test
 * supplies a tiny stand-in and inspects the element tree instead).
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Effects queued during one render, run after refs are attached (as React does). */
let pendingEffects = []
/** Cleanups of the effects from the previous render. */
let mountedCleanups = []

/** Minimal React stand-in: enough for a single render pass. */
const fakeReact = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useReducer(_reducer, initial) { return [initial, () => {}] },
  useEffect(fn) { pendingEffects.push(fn) },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef(value) { return { current: value } },
}

/** Attach refs and give every element the DOM methods this card touches. */
function attachRefs(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) attachRefs(child); return }
  if (node.props === undefined) return
  node.contains = target => target === node
  node.focus = () => {}
  node.scrollTop = 0
  node.scrollHeight = 0
  if (node.props.ref !== null && typeof node.props.ref === 'object') node.props.ref.current = node
  attachRefs(node.props.children)
}

let module = null
globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  __ModuleLoader__: { load(loaded) { module = loaded } },
}

/** Selection rectangle the stubbed page reports; tests move it around. */
let selectionRect = { left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20 }

/** Document-level listeners the card installs while it is open. */
const pageListeners = new Map()

globalThis.document = {
  getSelection() {
    return {
      rangeCount: 1,
      getRangeAt() {
        return {
          getClientRects: () => [selectionRect],
          getBoundingClientRect: () => selectionRect,
        }
      },
    }
  },
  addEventListener(type, listener) { pageListeners.set(type, listener) },
  removeEventListener(type) { pageListeners.delete(type) },
}

await import('./client.js')
if (module === null) throw new Error('client.js did not register a module')
if (module.id !== '@local/selection-followup') throw new Error(`unexpected id ${module.id}`)

const impl = module.factory(() => fakeReact)
const registrations = new Map()
const effects = []

const ctx = {
  effect(register, label) {
    effects.push(label)
    const disposer = register()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: {
    register() { return () => {} },
    bind() { return key => key },
  },
  uiConversation: {
    interactions: {
      register(definition) { registrations.set(`interaction:${definition.id}`, definition); return () => {} },
    },
  },
  slots: {
    inject(_name, callback) { return callback() },
    register(options, component) {
      registrations.set(`slot:${options.name}:${options.id ?? options.key}`, { options, component })
      return () => {}
    },
  },
}

impl.apply(ctx)

const interaction = registrations.get('interaction:selection-followup')
if (interaction === undefined) throw new Error('interaction was not registered')

const card = registrations.get('slot:shell.overlay:selection-followup')
if (card === undefined) throw new Error('overlay card was not registered')
if (card.options.locale !== 'selectionFollowup') throw new Error('card is not locale-bound')
if (impl.inject.includes('sidebarRight')) throw new Error('card must not depend on the sidebar')

// Copy lives in the card header: the shipped quote seat cannot be taken over.
let copiedText = null
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (text) => { copiedText = text } } },
})

/** Collect every string child of a rendered tree. */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.props?.children)
}

const t = key => key

/** Render one pass, attaching refs first and running effects afterwards (React order). */
function renderTree() {
  for (const cleanup of mountedCleanups) cleanup()
  mountedCleanups = []
  pendingEffects = []
  const tree = card.component({ t })
  attachRefs(tree)
  for (const fn of pendingEffects) {
    const cleanup = fn()
    mountedCleanups.push(typeof cleanup === 'function' ? cleanup : () => {})
  }
  return tree
}

const render = () => texts(renderTree()).join(' ')

// Closed before any selection: the overlay renders nothing at all.
if (render() !== '') throw new Error(`card should start closed, got: ${render()}`)

const select = (text) => {
  let prevented = false
  interaction.onInteraction({
    trigger: 'contextmenu', hasSelection: true, sessionId: 's1',
    readText: () => text, preventDefault: () => { prevented = true }, open: () => {},
  })
  return prevented
}

// Entry point: suppressing the native menu and opening the card.
if (!select('const a = 1\nreturn a')) throw new Error('native context menu was not suppressed')
let markup = render()
if (!markup.includes('title')) throw new Error('card title missing')
if (!markup.includes('quoteLabel')) throw new Error('quote card missing')
if (!markup.includes('preset.code.explain.label')) throw new Error('code presets missing')
if (!markup.includes('noteSelection')) throw new Error('context note missing')

// Placement: the card sits to the right of the selection, clamped to the viewport.
let style = renderTree().props.style
if (style.pointerEvents !== 'auto') throw new Error('card does not opt into pointer events')
if (style.left !== '310px' || style.top !== '192px') {
  throw new Error(`expected placement right of the selection, got ${style.left}/${style.top}`)
}

// No room on the right flips the card to the left of the selection.
selectionRect = { left: 1100, top: 200, right: 1190, bottom: 220, width: 90, height: 20 }
select('const b = 2\nreturn b')
style = renderTree().props.style
if (style.left !== '650px') throw new Error(`expected left-side placement, got ${style.left}`)

// A selection near the bottom pulls the card up so the composer still fits.
selectionRect = { left: 100, top: 700, right: 300, bottom: 720, width: 200, height: 20 }
select('const c = 3\nreturn c')
style = renderTree().props.style
if (style.top !== '368px' || style.maxHeight !== '420px') {
  throw new Error(`expected raised placement, got ${style.top}/${style.maxHeight}`)
}

selectionRect = { left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20 }
select('const a = 1\nreturn a')

// A right-click without a selection must stay untouched.
let preventedWithout = false
interaction.onInteraction({
  trigger: 'contextmenu', hasSelection: false, sessionId: 's1',
  readText: () => null, preventDefault: () => { preventedWithout = true }, open: () => {},
})
if (preventedWithout) throw new Error('suppressed the native menu without a selection')

// A plain selection gesture (mouse-up) is not ours: the built-in quote keeps it.
let openedOnSelection = false
const before = render()
interaction.onInteraction({
  trigger: 'selection', hasSelection: true, sessionId: 's1',
  readText: () => 'something else', preventDefault: () => { openedOnSelection = true }, open: () => {},
})
if (openedOnSelection) throw new Error('claimed the selection gesture')
if (render() !== before) throw new Error('selection gesture changed the card')

// Long Chinese paragraph gets the paragraph group.
select('这是'.repeat(60))
if (!render().includes('preset.chinese.expand.label')) throw new Error('paragraph presets missing')

// English prose gets the English group.
select('The quick brown fox jumps over the lazy dog, again and again.')
if (!render().includes('preset.english.translate.label')) throw new Error('english presets missing')

// A short token falls back to the default group.
select('OK')
if (!render().includes('preset.default.explain.label')) throw new Error('default presets missing')

// The send control is present, keeps a visible fill, and its glyph contrasts with it.
const buttons = []
const collectButtons = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collectButtons); return }
  if (node.type === 'button') buttons.push(node)
  collectButtons(node.props?.children)
}
collectButtons(renderTree())
const send = buttons.find(button => String(button.props.className ?? '') === 'sf-send')
if (send === undefined) throw new Error('send button missing')
if (send.props.style?.width !== '34px') throw new Error('send button lost its size')
if (send.props.style?.borderRadius !== '50%') throw new Error('send button is not circular')
if (!String(send.props['aria-label'] ?? '')) throw new Error('send button has no label')
const sendSvg = []
const collectSvg = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collectSvg); return }
  if (node.type === 'svg') sendSvg.push(node)
  collectSvg(node.props?.children)
}
collectSvg(send)
if (sendSvg.length !== 1) throw new Error('send button has no icon')
const sendPaths = []
const walkPath = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkPath); return }
  if (node.type === 'path') sendPaths.push(node.props?.d ?? '')
  walkPath(node.props?.children)
}
walkPath(sendSvg[0])
if (!sendPaths[0]?.startsWith('M8.3125 0.980206')) throw new Error('send icon path mismatch')
const close = buttons.find(button => texts(button).join('') === '×')
if (close === undefined) throw new Error('close button missing')

// Click-away dismissal: a pointerdown inside keeps the card, outside closes it.
select('const d = 4\nreturn d')
const tree = renderTree()
if (tree === null) throw new Error('card did not open')
if (typeof pageListeners.get('pointerdown') !== 'function') throw new Error('no click-away listener')
if (typeof pageListeners.get('keydown') !== 'function') throw new Error('no Escape listener')
pageListeners.get('pointerdown')({ target: tree })
if (renderTree() === null) throw new Error('card closed on a click inside it')
pageListeners.get('pointerdown')({ target: { node: 'outside' } })
if (renderTree() !== null) throw new Error('card did not close on a click outside')
if (pageListeners.size !== 0) throw new Error('dismissal listeners were not removed')

// Escape closes it too.
select('const e = 5\nreturn e')
renderTree()
pageListeners.get('keydown')({ key: 'Escape' })
if (renderTree() !== null) throw new Error('card did not close on Escape')

// Answers render as Markdown: no literal asterisks, real emphasis, lists and code.
select('const a = 1')
const asked = renderTree()
const chips = []
const collect = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node.type === 'button' && String(node.props.className ?? '') === 'sf-chip') chips.push(node)
  collect(node.props?.children)
}
collect(asked)
if (chips.length === 0) throw new Error('no preset chips to click')

const answer = [
  '**applied** 是 apply 的过去式，',
  '- 已应用 / 已生效',
  '- applied mathematics',
  '```js',
  'const a = 1',
  '```',
  '',
].join('\n')

const bodies = []
const encoder = new TextEncoder()
globalThis.fetch = async (_url, options) => {
  bodies.push(JSON.parse(options.body))
  return {
    ok: true,
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            const line = `${JSON.stringify({ t: 'delta', text: answer })}\n`
            return { done: false, value: encoder.encode(line) }
          },
        }
      },
    },
  }
}

chips[0].props.onClick()
await new Promise(resolve => setTimeout(resolve, 20))
if (bodies.at(-1).contextLimit !== 0) throw new Error('default mode should not request context')

const rendered = renderTree()
const nodes = []
const walk = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  nodes.push(node)
  walk(node.props?.children)
}
walk(rendered)
const strong = nodes.filter(node => node.type === 'strong').map(node => texts(node).join(''))
const items = nodes.filter(node => node.type === 'li').map(node => texts(node).join(''))
// A fenced block is a <pre> carrying the code typography; the quote card is the other <pre>.
const fences = nodes.filter(node => node.type === 'pre' && node.props.style?.fontSize === '13px')
if (strong.length === 0) throw new Error('bold markup was not rendered')
if (!strong.includes('applied')) throw new Error(`bold text wrong: ${strong}`)
if (items.length !== 2) throw new Error(`list items wrong: ${items.length}`)
if (fences.length !== 1) throw new Error(`code fence wrong: ${fences.length}`)
const plain = texts(rendered).join(' ')
if (plain.includes('**')) throw new Error('literal asterisks leaked into the answer')
if (plain.includes('```')) throw new Error('literal fence leaked into the answer')

// The excerpt folds away once an answer exists, and the header can bring it back.
const quotePres = nodes.filter(node => node.type === 'pre' && node.props.style?.fontSize !== '13px')
if (quotePres.length !== 0) throw new Error('excerpt stayed open after the answer arrived')
const showQuote = nodes.find(node => node.type === 'button' && texts(node).join('') === 'showQuote')
if (showQuote === undefined) throw new Error('no control to reopen the excerpt')
showQuote.props.onClick()
const reopened = renderTree()
const reopenedPres = []
const walkPre = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkPre); return }
  if (node.type === 'pre' && node.props.style?.fontSize !== '13px') reopenedPres.push(texts(node).join(''))
  walkPre(node.props?.children)
}
walkPre(reopened)
if (reopenedPres.length !== 1) throw new Error('excerpt did not reopen')

// A failed request gets a visible banner whose retry asks again.
let attempts = 0
globalThis.fetch = async () => { attempts += 1; throw new Error('boom') }
select('const f = 6')
const openedTree = renderTree()
const openedChips = []
const walkChips = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkChips); return }
  if (node.type === 'button' && String(node.props.className ?? '') === 'sf-chip') openedChips.push(node)
  walkChips(node.props?.children)
}
walkChips(openedTree)
openChipsLoop: for (const chip of openedChips) {
  chip.props.onClick()
  break openChipsLoop
}
await new Promise(resolve => setTimeout(resolve, 20))
const failedTree = renderTree()
const buttonsNow = []
const walkButtons = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkButtons); return }
  if (node.type === 'button') buttonsNow.push(node)
  walkButtons(node.props?.children)
}
walkButtons(failedTree)
if (!texts(failedTree).join(' ').includes('boom')) throw new Error('failure message missing')
const retry = buttonsNow.find(button => texts(button).join('') === 'retry')
if (retry === undefined) throw new Error('retry button missing')
retry.props.onClick()
await new Promise(resolve => setTimeout(resolve, 20))
if (attempts !== 2) throw new Error(`retry did not re-ask (attempts ${attempts})`)

// Context selector: the default asks for no context; "近 5 轮" asks for 10 messages.
globalThis.fetch = async (_url, options) => {
  bodies.push(JSON.parse(options.body))
  return {
    ok: true,
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: encoder.encode(`${JSON.stringify({ t: 'delta', text: 'ok' })}\n`) }
          },
        }
      },
    },
  }
}
select('const m = 7\nreturn m')
const modeButtons = []
const walkMode = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkMode); return }
  if (node.type === 'button') modeButtons.push(node)
  walkMode(node.props?.children)
}
walkMode(renderTree())
const recentMode = modeButtons.find(button => texts(button).join('') === 'context.recent')
if (recentMode === undefined) throw new Error('context mode selector missing')
recentMode.props.onClick()
const modeChips = modeButtons.filter(button => String(button.props.className ?? '') === 'sf-chip')
if (modeChips.length === 0) throw new Error('no chip to click after switching mode')
modeChips[0].props.onClick()
await new Promise(resolve => setTimeout(resolve, 20))
if (bodies.at(-1).contextLimit !== 10) throw new Error(`recent mode limit wrong: ${bodies.at(-1).contextLimit}`)

// The card header copies the excerpt.
select('copy me please')
const copyTree = renderTree()
const copyButtons = []
const walkCopy = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkCopy); return }
  if (node.type === 'button') copyButtons.push(node)
  walkCopy(node.props?.children)
}
walkCopy(copyTree)
const headerCopy = copyButtons.find(button => texts(button).join('') === 'copy')
if (headerCopy === undefined) throw new Error('header copy button missing')
headerCopy.props.onClick()
await new Promise(resolve => setTimeout(resolve, 10))
if (copiedText !== 'copy me please') throw new Error(`header copy wrote wrong text: ${copiedText}`)

// Wallpaper-engine compatibility: the glass override must be fully scoped to that
// plugin's own body attributes, and the default surface must stay the design token.
const styleNodes = []
const walkStyle = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkStyle); return }
  if (node.type === 'style') styleNodes.push(String(node.props.children ?? ''))
  walkStyle(node.props?.children)
}
walkStyle(copyTree)
if (styleNodes.length !== 1) throw new Error(`expected one style block, got ${styleNodes.length}`)
const css = styleNodes[0]
if (!css.includes('body[data-we-wallpaper] .sf-card')) throw new Error('wallpaper glass override missing')
if (!css.includes('--we-readability-base')) throw new Error('glass override does not follow the host variables')
if (!/backdrop-filter: blur\(var\(--we-floaters-blur/.test(css)) throw new Error('glass blur missing')
// Every `.sf-card` rule that sets a surface must sit behind the wallpaper scope.
for (const rule of css.split('}')) {
  if (!/\.sf-card\s*(\{|$)/.test(rule)) continue
  const selector = rule.split('{')[0]
  if (selector.includes('placeholder') || selector.includes(':hover') || selector.includes(':focus')) continue
  if (!selector.includes('[data-we-wallpaper]')) {
    throw new Error(`unscoped card surface rule: ${selector.trim()}`)
  }
}
// Without the plugin the card keeps the plain token background.
const cardNode = copyTree
if (cardNode.props.style.background !== 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay))') {
  throw new Error(`card background changed for non-wallpaper hosts: ${cardNode.props.style.background}`)
}
// The plain surface is a translucent mix of the host's own layer token: over a
// flat background it reads as the same colour, and it still needs no wallpaper.
const plainBg = String(cardNode.props.style.backgroundColor)
if (!plainBg.includes('--dsw-alias-bg-layer-2')) {
  throw new Error(`plain host lost its layer token: ${plainBg}`)
}
if (!plainBg.includes('94%')) throw new Error(`plain host surface is not the translucent base: ${plainBg}`)
// The wallpaper's readability base stays the first fallback on purpose: if the
// marker were ever missing on a wallpaper host, the surface must still follow it.
if (String(cardNode.props.style.backgroundColor).includes('--we-surface-tint')) {
  throw new Error('plain host picked up the wallpaper tint')
}

// With the wallpaper plugin active the surface is decided in JavaScript, so it
// works even where an ancestor selector could not reach the card.
let wallpaperOn = false
let darkOn = true
globalThis.document.body = {
  hasAttribute: name => (name === 'data-we-wallpaper'
    ? wallpaperOn
    : name === 'data-ds-dark-theme' ? darkOn : false),
}
select('const glass = 1')
if (!String(renderTree().props.style.backgroundColor).includes('--we-readability-base')) {
  // With the marker absent the surface must still be the base mix, not the tint.
}
if (String(renderTree().props.style.backgroundColor).includes('--we-surface-tint')) {
  throw new Error('wallpaper tint applied while the marker is absent')
}
wallpaperOn = true
select('const glass = 2')
const glassTree = renderTree()
const glassStyle = glassTree.props.style
if (typeof glassStyle.backdropFilter !== 'string' || !glassStyle.backdropFilter.includes('blur(')) {
  throw new Error(`wallpaper host did not get a blur surface: ${glassStyle.backdropFilter}`)
}
if (!String(glassStyle.backgroundColor).includes('color-mix')) {
  throw new Error(`wallpaper host did not get the glass mix: ${glassStyle.backgroundColor}`)
}
if (!String(glassStyle.backgroundColor).includes('--we-surface-tint-dark')) {
  throw new Error('dark theme did not pick the dark tint')
}
darkOn = false
const lightGlass = renderTree().props.style
if (!String(lightGlass.backgroundColor).includes('--we-surface-tint-light')) {
  throw new Error('light theme did not pick the light tint')
}
// The plain background token must survive underneath, so a browser without
// color-mix still paints something readable.
if (glassStyle.background !== 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay))') {
  throw new Error('glass surface replaced the fallback token')
}

console.log('client test: ok', { effects: effects.length })








