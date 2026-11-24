/**
 * Client half of the selection follow-up plugin.
 *
 * Registers one frame-wide overlay card. Selecting text in the main
 * conversation and choosing "Follow up" opens that card with the selection;
 * the card asks the Host over `/api/selection-followup/ask` and streams the
 * answer back. It reserves no column width, does not touch the sidebar layout,
 * and never writes to the main conversation.
 */

window.__ModuleLoader__.load({
  id: '@local/selection-followup',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Locale namespace of every visible string. */
    const NS = 'selectionFollowup'
    /** Host route registered by `index.js`, relative to the page origin. */
    const ROUTE = '/api/selection-followup/ask'
    /** Interaction id admitted for the right-click gesture. */
    const INTERACTION = 'selection-followup'
    /** Overlay entry id. */
    const OVERLAY = 'selection-followup'

    /** How many conversation messages each context mode asks the Host for. */
    const CONTEXT_LIMITS = { selection: 0, recent: 10, all: 40 }
    /** Context modes, in display order. */
    const CONTEXT_MODES = ['selection', 'recent', 'all']

    // --- panel state ------------------------------------------------------

    /** Card state: which Session it belongs to, the excerpt, where it was selected, and whether it shows. */
    const state = {
      sessionId: null,
      selection: null,
      anchor: null,
      visible: false,
      quoteOpen: true,
      error: null,
      contextMode: 'selection',
      contextCount: null,
      contextChars: 0,
      contextFrom: 0,
      contextTo: 0,
      turns: [],
    }
    const listeners = new Set()

    const panelStore = {
      get() { return state },
      /** Show the card for a fresh selection, discarding the previous conversation. */
      open(sessionId, selection, anchor) {
        state.sessionId = sessionId
        state.selection = selection
        state.anchor = anchor
        state.turns = []
        state.quoteOpen = true
        state.error = null
        state.contextCount = null
        state.visible = true
        notify()
      },
      /** Record how many conversation messages the Host attached. */
      setContext(count, chars, from, to) {
        state.contextCount = count
        state.contextChars = chars
        state.contextFrom = from
        state.contextTo = to
        notify()
      },
      /** Choose how much conversation the next question carries. */
      setContextMode(mode) {
        state.contextMode = mode
        state.contextCount = null
        notify()
      },
      /** Replace the conversation turns; the excerpt folds away once an answer starts. */
      setTurns(turns) {
        state.turns = turns
        if (turns.some(turn => turn.role === 'assistant' && turn.text.trim() !== '')) state.quoteOpen = false
        notify()
      },
      /** Record a failed request so the card can offer a retry. */
      fail(question, message) {
        state.error = { question, message }
        notify()
      },
      /** Drop the failure notice. */
      clearError() {
        if (state.error === null) return
        state.error = null
        notify()
      },
      /** Fold or unfold the selected excerpt. */
      toggleQuote() {
        state.quoteOpen = !state.quoteOpen
        notify()
      },
      close() {
        state.visible = false
        notify()
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }

    function notify() {
      for (const listener of listeners) listener()
    }

    /** Re-render the caller whenever the card state changes. */
    function usePanelState() {
      const [, force] = React.useReducer(value => value + 1, 0)
      useEffect(() => panelStore.subscribe(force), [])
      return panelStore.get()
    }

    // --- content classification -------------------------------------------

    /** Per-group preset ids; the group picks which three the card offers. */
    const PRESET_GROUPS = {
      code: ['explain', 'issues', 'annotate'],
      english: ['translate', 'explain', 'simplify'],
      chinese: ['expand', 'example', 'simplify'],
      default: ['explain', 'example', 'rephrase'],
    }

    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
    const CODE_KEYWORD = /\b(const|let|var|function|class|def|import|export|return|async|await|public|private|protected|void|int|string|float|double|boolean|struct|interface|enum|package|using|namespace|new)\b/u
    const CODE_PUNCTUATION = /[=;{}()[\]<>]|=>|->|::/u

    /**
     * Classify a selection so the card offers the three questions that fit.
     * @param text - selected text.
     * @returns one of `code`, `english`, `chinese`, `default`.
     */
    function classify(text) {
      const trimmed = text.trim()
      if (trimmed === '') return 'default'
      const lines = trimmed.split(/\r?\n/u)
      const indented = lines.filter(line => /^ {2,}\S/u.test(line)).length
      if (CODE_KEYWORD.test(trimmed) && CODE_PUNCTUATION.test(trimmed)) return 'code'
      if ((trimmed.match(/[{};]/gu) ?? []).length >= 2) return 'code'
      if (indented >= 2 && /;\s*$|[)\]}]\s*$/mu.test(trimmed)) return 'code'
      const hasCjk = CJK.test(trimmed)
      if (!hasCjk) {
        const letters = (trimmed.match(/[A-Za-z]/gu) ?? []).length
        return letters >= 20 ? 'english' : 'default'
      }
      return trimmed.length >= 60 ? 'chinese' : 'default'
    }

    /**
     * The three questions offered for one selection.
     * @param text - selected text.
     * @param t - locale translator.
     * @returns label/prompt pairs.
     */
    function presetsOf(text, t) {
      const group = classify(text)
      return PRESET_GROUPS[group].map(id => ({
        id,
        label: t(`preset.${group}.${id}.label`),
        prompt: t(`preset.${group}.${id}.prompt`),
      }))
    }

    // --- i18n -------------------------------------------------------------

    const ZH = {
      title: '追问',
      empty: '在主对话里选中一段文字，右键选择「追问」。',
      quoteLabel: '选中的内容',
      showQuote: '原文',
      more: '展开',
      less: '收起',
      placeholder: '追问这段内容…（Enter 发送，Shift+Enter 换行）',
      send: '发送',
      stop: '停止',
      thinking: '正在思考…',
      privateNote: '只在这里显示，不写入主对话',
      copy: '复制',
      copied: '已复制',
      quote: '引用',
      contextLabel: '上下文',
      'context.selection': '仅选中',
      'context.recent': '近 5 轮',
      'context.all': '全部',
      noteSelection: '仅引用这段 · 不写入主对话',
      contextNote: '已带 Q{from}–Q{to} · {n} 条',
      noContext: '这次没取到上下文，只带上了这段引用',
      error: '出错',
      retry: '重试',
      dismiss: '忽略',
      aborted: '已停止',
      close: '关闭',
      'preset.code.explain.label': '解释',
      'preset.code.explain.prompt': '请逐行解释这段代码的作用和关键逻辑。',
      'preset.code.issues.label': '找问题',
      'preset.code.issues.prompt': '请找出这段代码可能的问题或边界错误，并说明原因。',
      'preset.code.annotate.label': '加注释',
      'preset.code.annotate.prompt': '请给这段代码加上简洁的中文注释。',
      'preset.english.translate.label': '翻译',
      'preset.english.translate.prompt': '请把这段内容翻译成中文。',
      'preset.english.explain.label': '解释意思',
      'preset.english.explain.prompt': '请用简单的中文解释这段内容的意思。',
      'preset.english.simplify.label': '说简单点',
      'preset.english.simplify.prompt': '请把这段内容改写成更简单易懂的英文，并附一句中文说明。',
      'preset.chinese.expand.label': '展开讲讲',
      'preset.chinese.expand.prompt': '请展开讲讲这段内容，补充背景和细节。',
      'preset.chinese.example.label': '举个例子',
      'preset.chinese.example.prompt': '请举一个具体的例子说明这段内容。',
      'preset.chinese.simplify.label': '说简单点',
      'preset.chinese.simplify.prompt': '请用更简单的话重新说一遍这段内容。',
      'preset.default.explain.label': '解释',
      'preset.default.explain.prompt': '请解释这段内容。',
      'preset.default.example.label': '举个例子',
      'preset.default.example.prompt': '请举一个例子说明这段内容。',
      'preset.default.rephrase.label': '换个说法',
      'preset.default.rephrase.prompt': '请换个说法解释这段内容。',
    }

    const EN = {
      title: 'Follow up',
      empty: 'Select text in the main conversation, then right-click and choose “Follow up”.',
      quoteLabel: 'Selection',
      showQuote: 'Excerpt',
      more: 'Show more',
      less: 'Show less',
      placeholder: 'Ask about this selection… (Enter sends, Shift+Enter adds a line)',
      send: 'Send',
      stop: 'Stop',
      thinking: 'Thinking…',
      privateNote: 'Shown here only; the main conversation is not written to',
      copy: 'Copy',
      copied: 'Copied',
      quote: 'Quote',
      contextLabel: 'Context',
      'context.selection': 'Selection',
      'context.recent': 'Last 5',
      'context.all': 'All',
      noteSelection: 'Excerpt only · not written to the main conversation',
      contextNote: 'Q{from}–Q{to} · {n} messages',
      noContext: 'No conversation context was available this time; the answer only sees this excerpt.',
      error: 'Error',
      retry: 'Retry',
      dismiss: 'Dismiss',
      aborted: 'Stopped',
      close: 'Close',
      'preset.code.explain.label': 'Explain',
      'preset.code.explain.prompt': 'Explain what this code does line by line and call out the key logic.',
      'preset.code.issues.label': 'Find issues',
      'preset.code.issues.prompt': 'Point out likely bugs or edge cases in this code and explain why.',
      'preset.code.annotate.label': 'Add comments',
      'preset.code.annotate.prompt': 'Add concise comments to this code.',
      'preset.english.translate.label': 'Translate',
      'preset.english.translate.prompt': 'Translate this text into Chinese.',
      'preset.english.explain.label': 'Explain',
      'preset.english.explain.prompt': 'Explain what this text means in plain Chinese.',
      'preset.english.simplify.label': 'Simplify',
      'preset.english.simplify.prompt': 'Rewrite this text in simpler English, with one sentence in Chinese.',
      'preset.chinese.expand.label': 'Expand',
      'preset.chinese.expand.prompt': 'Expand on this passage and add the background and details it leaves out.',
      'preset.chinese.example.label': 'Example',
      'preset.chinese.example.prompt': 'Give one concrete example that explains this passage.',
      'preset.chinese.simplify.label': 'Simplify',
      'preset.chinese.simplify.prompt': 'Restate this passage in simpler words.',
      'preset.default.explain.label': 'Explain',
      'preset.default.explain.prompt': 'Explain this text.',
      'preset.default.example.label': 'Example',
      'preset.default.example.prompt': 'Give an example that explains this text.',
      'preset.default.rephrase.label': 'Rephrase',
      'preset.default.rephrase.prompt': 'Rephrase this text in other words.',
    }

    // --- placement --------------------------------------------------------

    /**
     * Viewport rectangle of the browser selection at gesture time.
     * @returns the last client rect of the selection, or null when there is none.
     */
    function selectionAnchor() {
      if (typeof document === 'undefined' || typeof document.getSelection !== 'function') return null
      const selection = document.getSelection()
      if (selection === null || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      const rects = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : []
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
      if (rect === undefined || rect === null) return null
      if (!(rect.width > 0 || rect.height > 0)) return null
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }

    /**
     * Place the card at the right of the selection, clamped to the viewport.
     * @param anchor - selection rectangle, or null for the default corner.
     * @returns absolute position and height styles.
     */
    function placementOf(anchor) {
      const width = 440
      const margin = 12
      const gap = 10
      // Below this the composer and the suggestion chips start to be squeezed.
      const minimumHeight = 420
      const viewWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const viewHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      if (anchor === null || !(viewWidth > 0) || !(viewHeight > 0)) {
        return {
          left: 'auto', top: 'auto', right: '24px', bottom: '96px',
          maxHeight: 'min(560px, calc(100vh - 180px))',
        }
      }
      const rightRoom = viewWidth - anchor.right - gap - margin
      const leftRoom = anchor.left - gap - margin
      let left
      if (rightRoom >= width) left = anchor.right + gap
      else if (leftRoom >= width) left = anchor.left - gap - width
      else left = Math.max(margin, Math.min(anchor.right + gap, viewWidth - width - margin))
      // Pull the card up when the selection sits low, so a usable height always fits above the viewport edge.
      const top = Math.max(margin, Math.min(anchor.top - 8, viewHeight - margin - minimumHeight))
      const maxHeight = Math.max(280, Math.min(560, viewHeight - top - margin))
      return {
        left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto',
        maxHeight: `${maxHeight}px`,
      }
    }

    /** Official send glyph (16×16 arrow), drawn with `currentColor`. */
    const SEND_ICON = 'M8.3125 0.980206C8.66767 1.05312 8.97902 1.2042 9.2627 1.43235C9.48724 1.613 9.73029 1.85795 9.97949 2.10716L14.707 6.8347L13.293 8.24876L9 3.95579V15.0417H7V3.95579L2.70703 8.24876L1.29297 6.8347L6.02051 2.10716C6.26971 1.85795 6.51277 1.613 6.7373 1.43235C6.97662 1.23988 7.28445 1.04404 7.6875 0.980206C7.8973 0.947029 8.1031 0.955183 8.3125 0.980206Z'

    // --- styles -----------------------------------------------------------
    //
    // Geometry, type and colour follow the official DeepSeek chat client
    // (deepseek-ai/chat-demo): the same `--dsw-*` design tokens, pill controls,
    // 12–16px radii, the elevated menu surface and its level-3 shadow. Every
    // token has a fallback so a host that ships a narrower token set still
    // renders the same shapes.

    const COLORS = {
      text: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      caption: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary))',
      tertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      border: 'var(--dsw-alias-border-l2, var(--dsw-alias-border-l1))',
      borderThin: 'var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l1))',
      surface: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))',
      input: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1))',
      bubble: 'var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-2))',
      brand: 'var(--dsw-alias-brand-primary)',
      brandText: 'var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary))',
      primary: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))',
      primaryHover: 'var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary))',
      // Text on a `button-primary-fill` surface: the DSH brand fill flips
      // between near-black and near-white, so the glyph must use the paired
      // inverted label, not a fixed white.
      onPrimary: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06))',
      error: 'var(--dsw-alias-state-error-primary)',
      // DeepSeek's official accent: the app's send control is blue-450 in dark
      // and blue-500 in light; the host brand is monochrome, so this is set here.
      blue: 'var(--dsw-static-blue-450, #5686fe)',
      blueHover: 'var(--dsw-static-blue-500, #3964fe)',
      blueSoft: 'rgba(77, 107, 254, 0.12)',
      blueBorder: 'rgba(77, 107, 254, 0.45)',
      shadow: 'var(--dsw-shadow-lv3, 0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08))',
      font: 'var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif)',
    }

    /** Hover, disabled and focus states live in one component-local stylesheet. */
    const CARD_CSS = `
.sf-close:hover, .sf-chip:hover { background: ${COLORS.hover}; }
.sf-quote-toggle:hover { background: ${COLORS.hover}; }
.sf-stop { background: ${COLORS.blue}; color: #ffffff; }
.sf-stop:hover { background: ${COLORS.blueHover}; }
.sf-send { background: ${COLORS.blue}; color: #ffffff; }
.sf-send:hover:not(:disabled) { background: ${COLORS.blueHover}; }
.sf-send:disabled { opacity: 0.45; cursor: not-allowed; }
.sf-close:focus-visible, .sf-chip:focus-visible, .sf-send:focus-visible, .sf-stop:focus-visible {
  outline: none; box-shadow: 0 0 0 2px ${COLORS.blue};
}
.sf-card textarea::placeholder { color: ${COLORS.caption}; }

/* Liquid glass while dsh-plugin-wallpaper-engine is active.
   That plugin rewrites the host's surfaces into translucent glass, but it only
   retargets surfaces it knows; this card is not one of them, so it would stay an
   opaque slab floating over the wallpaper — the reported colour block. These
   rules are scoped to that plugin's own body attributes and variables, so a host
   without it never matches the selector and renders exactly as before. */
body[data-we-wallpaper]:not([data-ds-dark-theme]) .sf-card { --sf-we-tint: var(--we-surface-tint-light, #ffffff); }
body[data-we-wallpaper][data-ds-dark-theme] .sf-card { --sf-we-tint: var(--we-surface-tint-dark, #0d1524); }
body[data-we-wallpaper] .sf-card {
  background-color: color-mix(in srgb,
    var(--we-readability-base, #14161b) calc(max(var(--we-readability-floor, 0.82), 0.82) * 100%),
    color-mix(in srgb, var(--sf-we-tint, #ffffff) calc(var(--we-floaters-alpha, var(--we-glass-alpha, 0.22)) * 100%), transparent) calc((1 - max(var(--we-readability-floor, 0.82), 0.82)) * 100%)) !important;
  background-image: linear-gradient(180deg, var(--we-glass-highlight, rgba(255, 255, 255, 0.10)), rgba(255, 255, 255, 0.02) 40%, rgba(255, 255, 255, 0) 100%) !important;
  -webkit-backdrop-filter: blur(var(--we-floaters-blur, var(--we-blur, 18px))) saturate(var(--we-saturate, 1.2));
  backdrop-filter: blur(var(--we-floaters-blur, var(--we-blur, 18px))) saturate(var(--we-saturate, 1.2));
  border-color: var(--we-border, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14))) !important;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
body[data-we-wallpaper] .sf-card .sf-quote { background: rgba(255, 255, 255, 0.06) !important; }
/* Follow the wallpaper's own accent for the two round buttons and the active
   context chip; without the plugin these rules never match. */
body[data-we-wallpaper] .sf-send,
body[data-we-wallpaper] .sf-stop { background: var(--we-ui-send, var(--we-accent, ${COLORS.blue})); }
body[data-we-wallpaper] .sf-send:hover:not(:disabled) {
  background: color-mix(in srgb, var(--we-ui-send, var(--we-accent, ${COLORS.blue})) 82%, #000000);
}
body[data-we-wallpaper] .sf-mode-on {
  border-color: var(--we-accent, ${COLORS.blue}) !important;
  color: var(--we-accent, ${COLORS.blue}) !important;
  background: color-mix(in srgb, var(--we-accent, ${COLORS.blue}) 16%, transparent) !important;
}
`

    const styles = {
      card: {
        position: 'fixed', right: '24px', bottom: '96px', width: '440px',
        maxWidth: 'calc(100vw - 48px)', maxHeight: 'min(600px, calc(100vh - 160px))',
        display: 'flex', flexDirection: 'column', gap: '12px',
        padding: '16px', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay))',
        color: COLORS.text, fontFamily: COLORS.font,
        fontSize: '14px', lineHeight: '22px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06))',
        borderRadius: '24px',
        boxShadow: COLORS.shadow,
        pointerEvents: 'auto',
        zIndex: 40,
        overflow: 'hidden',
      },
      head: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', minHeight: '32px',
      },
      headTitle: {
        display: 'flex', alignItems: 'center', gap: '6px',
        fontSize: '14px', fontWeight: 500, lineHeight: '22px',
        color: COLORS.secondary,
      },
      close: {
        border: 0, background: 'transparent', color: COLORS.secondary, cursor: 'pointer',
        fontSize: '18px', lineHeight: 1, padding: 0, borderRadius: '50%',
        width: '28px', height: '28px', display: 'flex', alignItems: 'center',
        justifyContent: 'center', flex: '0 0 auto',
      },
      quote: {
        border: 0, borderRadius: '16px',
        background: 'var(--dsw-alias-bg-skeleton, rgba(255, 255, 255, 0.08))',
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px',
        maxHeight: '128px', overflow: 'hidden',
      },
      quoteHead: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', fontSize: '12px', lineHeight: '18px', color: COLORS.caption,
      },
      quoteToggle: {
        border: 0, padding: '2px 8px', borderRadius: '12px', cursor: 'pointer',
        background: 'transparent', color: COLORS.caption, font: 'inherit',
        fontSize: '12px', lineHeight: '18px',
      },
      quoteText: {
        margin: 0, font: 'inherit', fontSize: '14px', lineHeight: '22px',
        color: COLORS.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        overflow: 'auto', minHeight: 0,
      },
      linkButton: {
        border: 0, padding: 0, background: 'transparent', color: COLORS.blue,
        cursor: 'pointer', font: 'inherit', fontSize: '12px', lineHeight: '18px',
      },
      turns: {
        flex: '1 1 auto', minHeight: '0px', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '12px', padding: 0,
      },
      userTurn: {
        alignSelf: 'flex-end', maxWidth: '92%', background: COLORS.bubble,
        borderRadius: '12px', padding: '10px 14px', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', fontSize: '14px', lineHeight: '22px',
      },
      assistantTurn: {
        alignSelf: 'stretch', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: '15px', lineHeight: '24px',
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '8px', flexShrink: 0 },
      chip: {
        border: `1px solid ${COLORS.border}`, background: 'transparent',
        color: COLORS.text, borderRadius: '18px', height: '34px',
        padding: '0 12px', fontSize: '13px', lineHeight: '20px', fontWeight: 500,
        cursor: 'pointer', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', gap: '6px',
      },
      chipArrow: { color: COLORS.caption, fontSize: '13px', lineHeight: 1 },
      modeRow: {
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        padding: '0 0 8px 0', flexShrink: 0,
      },
      modeLabel: { fontSize: '12px', lineHeight: '18px', color: COLORS.caption, marginRight: '2px' },
      modeChip: {
        border: `1px solid ${COLORS.border}`, background: 'transparent',
        color: COLORS.caption, borderRadius: '12px', height: '26px',
        padding: '0 10px', fontSize: '12px', lineHeight: '18px', fontWeight: 400,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      },
      modeChipActive: {
        border: `1px solid ${COLORS.blue}`, background: 'rgba(77, 107, 254, 0.12)',
        color: COLORS.blue, borderRadius: '12px', height: '26px',
        padding: '0 10px', fontSize: '12px', lineHeight: '18px', fontWeight: 500,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      },
      composer: {
        border: 0, borderRadius: '20px', background: 'transparent',
        display: 'flex', flexDirection: 'column',
        gap: '0px', padding: 0, flexShrink: 0,
      },
      textarea: {
        border: 0, outline: 'none', resize: 'none', background: 'transparent',
        color: COLORS.text, font: 'inherit', fontSize: '16px', lineHeight: '24px',
        minHeight: '48px', maxHeight: '132px', padding: '12px 12px 0 16px',
        boxSizing: 'border-box', width: '100%',
        caretColor: COLORS.blue,
      },
      composerRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', padding: '10px 0 0 0',
      },
      note: { fontSize: '12px', lineHeight: '18px', color: COLORS.caption },
      hint: { fontSize: '12px', lineHeight: '18px', color: COLORS.secondary, flexShrink: 0 },
      md: { display: 'block' },
      mdP: { margin: '0 0 10px 0' },
      mdPLast: { margin: '0' },
      mdList: { margin: '0 0 10px 0', paddingLeft: '20px' },
      mdLi: { margin: '0 0 4px 0' },
      mdH1: { margin: '0 0 10px 0', fontSize: '18px', lineHeight: '26px', fontWeight: 600 },
      mdH2: { margin: '0 0 8px 0', fontSize: '16px', lineHeight: '24px', fontWeight: 600 },
      mdH3: { margin: '0 0 8px 0', fontSize: '15px', lineHeight: '24px', fontWeight: 600 },
      mdQuote: {
        margin: '0 0 10px 0', padding: '2px 0 2px 12px',
        borderLeft: `3px solid ${COLORS.border}`, color: COLORS.secondary,
      },
      mdHr: { margin: '12px 0', border: 0, borderTop: `1px solid ${COLORS.border}` },
      mdCodeBlock: {
        margin: '0 0 10px 0', padding: '10px 12px', borderRadius: '12px',
        background: 'var(--dsw-alias-markdown-code-block, rgba(255,255,255,0.06))',
        overflowX: 'auto', fontSize: '13px', lineHeight: '20px',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
      },
      inlineCode: {
        padding: '1px 5px', borderRadius: '5px',
        background: 'var(--dsw-alias-markdown-inline-code, rgba(255,255,255,0.08))',
        fontSize: '0.92em',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
      },
      mdLink: { color: COLORS.blue, textDecoration: 'none' },
      errorBox: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '8px 10px', borderRadius: '12px',
        border: `1px solid ${COLORS.error}`,
        background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(242, 90, 90, 0.08))',
      },
      errorText: { flex: '1 1 120px', minWidth: 0, color: COLORS.error, fontSize: '12px', lineHeight: '18px', wordBreak: 'break-word' },
      errorAction: {
        border: 0, borderRadius: '14px', padding: '3px 12px', cursor: 'pointer',
        background: COLORS.blue, color: '#ffffff', font: 'inherit',
        fontSize: '12px', lineHeight: '18px',
      },
      errorDismiss: {
        border: 0, padding: '3px 8px', borderRadius: '14px', cursor: 'pointer',
        background: 'transparent', color: COLORS.caption, font: 'inherit',
        fontSize: '12px', lineHeight: '18px',
      },
      action: {
        border: 0, borderRadius: '50%', width: '34px', height: '34px', padding: 0,
        fontSize: '17px', cursor: 'pointer', font: 'inherit',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flex: '0 0 auto',
      },
      actionStop: {
        border: 0, borderRadius: '50%', width: '34px', height: '34px', padding: 0,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', flex: '0 0 auto',
      },
    }

    // --- markdown ---------------------------------------------------------
    //
    // Answers arrive as Markdown. The card cannot import the host's renderer,
    // so this covers the subset a short Q&A answer uses: headings, lists,
    // quotes, fenced code, rules, and bold/italic/inline-code/links.

    const INLINE_TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*|~~[^~\n]+~~)/u
    const FENCE = /^\s*```/u
    const HEADING = /^(#{1,6})\s+(.*)$/u
    const BULLET = /^\s*[-*+]\s+(.*)$/u
    const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u
    const QUOTE = /^\s*>\s?(.*)$/u
    const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u
    const BLANK = /^\s*$/u

    let inlineKey = 0

    /**
     * Render one line's inline markup.
     * @param text - a single line of Markdown.
     * @returns React children.
     */
    function renderInline(text) {
      const parts = []
      let rest = text
      while (rest !== '') {
        const match = INLINE_TOKEN.exec(rest)
        if (match === null) { parts.push(rest); break }
        if (match.index > 0) parts.push(rest.slice(0, match.index))
        const token = match[0]
        const key = `i${inlineKey++}`
        if (token.startsWith('**')) parts.push(h('strong', { key }, token.slice(2, -2)))
        else if (token.startsWith('`')) parts.push(h('code', { key, style: styles.inlineCode }, token.slice(1, -1)))
        else if (token.startsWith('~~')) parts.push(h('s', { key }, token.slice(2, -2)))
        else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)
          parts.push(h('a', {
            key, href: link[2], target: '_blank', rel: 'noreferrer', style: styles.mdLink,
          }, link[1]))
        } else parts.push(h('em', { key }, token.slice(1, -1)))
        rest = rest.slice(match.index + token.length)
      }
      return parts
    }

    /** True when a line starts a block the paragraph collector must stop at. */
    function startsBlock(line) {
      return FENCE.test(line) || HEADING.test(line) || BULLET.test(line)
        || NUMBERED.test(line) || QUOTE.test(line) || RULE.test(line)
    }

    /**
     * Render Markdown blocks.
     * @param text - the whole answer.
     * @returns React children.
     */
    function renderMarkdown(text) {
      const lines = String(text).split(/\r?\n/u)
      const blocks = []
      let index = 0
      const push = (node) => blocks.push(node)
      while (index < lines.length) {
        const line = lines[index]
        if (BLANK.test(line)) { index += 1; continue }
        if (FENCE.test(line)) {
          const body = []
          index += 1
          while (index < lines.length && !FENCE.test(lines[index])) { body.push(lines[index]); index += 1 }
          index += 1
          push(h('pre', { key: `b${blocks.length}`, style: styles.mdCodeBlock }, h('code', null, body.join('\n'))))
          continue
        }
        const heading = HEADING.exec(line)
        if (heading !== null) {
          const level = Math.min(heading[1].length, 3)
          const style = level === 1 ? styles.mdH1 : level === 2 ? styles.mdH2 : styles.mdH3
          push(h(`h${level}`, { key: `b${blocks.length}`, style }, renderInline(heading[2])))
          index += 1
          continue
        }
        if (RULE.test(line)) { push(h('hr', { key: `b${blocks.length}`, style: styles.mdHr })); index += 1; continue }
        const bullet = BULLET.exec(line)
        if (bullet !== null) {
          const items = []
          while (index < lines.length) {
            const item = BULLET.exec(lines[index])
            if (item === null) break
            items.push(h('li', { key: `li${items.length}`, style: styles.mdLi }, renderInline(item[1])))
            index += 1
          }
          push(h('ul', { key: `b${blocks.length}`, style: styles.mdList }, items))
          continue
        }
        const numbered = NUMBERED.exec(line)
        if (numbered !== null) {
          const items = []
          while (index < lines.length) {
            const item = NUMBERED.exec(lines[index])
            if (item === null) break
            items.push(h('li', { key: `li${items.length}`, style: styles.mdLi }, renderInline(item[1])))
            index += 1
          }
          push(h('ol', { key: `b${blocks.length}`, style: styles.mdList }, items))
          continue
        }
        const quoted = QUOTE.exec(line)
        if (quoted !== null) {
          const body = []
          while (index < lines.length) {
            const item = QUOTE.exec(lines[index])
            if (item === null) break
            body.push(item[1])
            index += 1
          }
          push(h('blockquote', { key: `b${blocks.length}`, style: styles.mdQuote }, renderInline(body.join('\n'))))
          continue
        }
        const paragraph = []
        while (index < lines.length && !BLANK.test(lines[index]) && !startsBlock(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        const last = index >= lines.length
        push(h('p', {
          key: `b${blocks.length}`,
          style: last ? styles.mdPLast : styles.mdP,
        }, renderInline(paragraph.join('\n'))))
        if (paragraph.length === 0) index += 1
      }
      return blocks
    }

    // --- wallpaper coexistence --------------------------------------------
    //
    // `dsh-plugin-wallpaper-engine` turns the host surfaces into liquid glass and
    // marks the document with `data-we-wallpaper`. Surfaces it does not know keep
    // their own opaque background, which reads as a solid slab over the wallpaper.
    //
    // The surface is decided in JavaScript rather than with an ancestor selector:
    // a `body[...] .sf-card` rule cannot match if this slot renders inside a shadow
    // root, and that failure is silent. The values are still the plugin's own
    // variables, so its sliders keep retinting the card.

    /** Marker the wallpaper plugin writes on <body> while it is active. */
    const WALLPAPER_ATTR = 'data-we-wallpaper'

    /** Accent used for the round actions while a wallpaper is active. */
    const ACCENT = 'var(--we-ui-send, var(--we-accent, #5686fe))'

    /**
     * Whether the wallpaper plugin currently owns the page background.
     * @returns true while a wallpaper is active.
     */
    function wallpaperActive() {
      if (typeof document === 'undefined') return false
      const body = document.body
      if (body === null || body === undefined) return false
      return typeof body.hasAttribute === 'function' && body.hasAttribute(WALLPAPER_ATTR)
    }

    /**
     * Glass surface matching the wallpaper plugin, or null on a plain host.
     * @returns the style fragment merged into the card, or null.
     */
    function wallpaperSurface() {
      const wallpaper = wallpaperActive()
      // Base colour: the wallpaper plugin's readability base when it is present,
      // otherwise the host's own layer token. The second half of the fallback
      // chain is what a plain host keeps using, so the card never depends on
      // detection succeeding — a missed marker costs tint, not the surface.
      const base = 'var(--we-readability-base, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #2c2c2e)))'
      const surface = {
        // 94% opaque: over a flat host background this is the same colour to the
        // eye, over a wallpaper it lets the picture through like the host panels.
        backgroundColor: `color-mix(in srgb, ${base} 94%, transparent)`,
        backdropFilter: 'blur(var(--we-floaters-blur, var(--we-blur, 18px))) saturate(var(--we-saturate, 1.2))',
        WebkitBackdropFilter: 'blur(var(--we-floaters-blur, var(--we-blur, 18px))) saturate(var(--we-saturate, 1.2))',
      }
      if (!wallpaper) return surface
      const body = document.body
      const dark = typeof body.hasAttribute === 'function' && body.hasAttribute('data-ds-dark-theme')
      const tint = dark
        ? 'var(--we-surface-tint-dark, #0d1524)'
        : 'var(--we-surface-tint-light, #ffffff)'
      const floor = 'max(var(--we-readability-floor, 0.82), 0.82)'
      return {
        ...surface,
        backgroundColor: `color-mix(in srgb, var(--we-readability-base, #14161b) calc(${floor} * 100%), `
          + `color-mix(in srgb, ${tint} calc(var(--we-floaters-alpha, var(--we-glass-alpha, 0.22)) * 100%), transparent) `
          + `calc((1 - ${floor}) * 100%))`,
        backgroundImage: 'linear-gradient(180deg, var(--we-glass-highlight, rgba(255, 255, 255, 0.10)), '
          + 'rgba(255, 255, 255, 0.02) 40%, rgba(255, 255, 255, 0) 100%)',
        borderColor: 'var(--we-border, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14)))',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
      }
    }

    // --- component --------------------------------------------------------

    /**
     * Render the floating follow-up card.
     * @param props - locale seat.
     * @returns the card, or nothing while it is closed.
     */
    function FollowUpCard(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const current = usePanelState()
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [expanded, setExpanded] = useState(false)
      const [copied, setCopied] = useState(false)
      const abortRef = useRef(null)
      const listRef = useRef(null)
      const inputRef = useRef(null)
      const cardRef = useRef(null)

      const visible = current.visible
      const sessionId = current.sessionId
      const selection = current.selection
      const turns = current.turns
      const placement = useMemo(() => placementOf(current.anchor), [current.anchor, visible])
      // Re-read the wallpaper marker when the plugin activates or leaves; the
      // observer also covers the case where the page loads with it already on.
      const [, bumpWallpaper] = React.useReducer(value => value + 1, 0)
      useEffect(() => {
        if (!visible || typeof document === 'undefined' || typeof MutationObserver !== 'function') return
        const body = document.body
        if (body === null || body === undefined) return
        const observer = new MutationObserver(() => { bumpWallpaper() })
        observer.observe(body, { attributes: true, attributeFilter: [WALLPAPER_ATTR, 'data-ds-dark-theme'] })
        return () => { observer.disconnect() }
      }, [visible])
      const wallpaper = wallpaperActive()
      const surface = wallpaperSurface()

      useEffect(() => {
        if (!visible) return
        setDraft('')
        setExpanded(false)
        setCopied(false)
        inputRef.current?.focus({ preventScroll: true })
      }, [visible, selection])

      useEffect(() => {
        const element = listRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [turns])

      // Click-away and Escape dismiss the card: the close button is only one way out.
      useEffect(() => {
        if (!visible) return
        const page = typeof document === 'undefined' ? null : document
        if (page === null || typeof page.addEventListener !== 'function') return
        const onPointerDown = (event) => {
          const card = cardRef.current
          if (card === null || card.contains(event.target)) return
          panelStore.close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') panelStore.close()
        }
        page.addEventListener('pointerdown', onPointerDown, true)
        page.addEventListener('keydown', onKeyDown)
        return () => {
          page.removeEventListener('pointerdown', onPointerDown, true)
          page.removeEventListener('keydown', onKeyDown)
        }
      }, [visible])

      const appendAssistant = useCallback((text) => {
        const list = panelStore.get().turns.slice()
        const last = list[list.length - 1]
        if (last === undefined || last.role !== 'assistant') return
        list[list.length - 1] = { ...last, text: last.text + text }
        panelStore.setTurns(list)
      }, [])

      const ask = useCallback(async (question) => {
        const text = question.trim()
        if (text === '' || busy) return
        const history = panelStore.get().turns.map(turn => ({ role: turn.role, text: turn.text }))
        panelStore.clearError()
        panelStore.setTurns([...history, { role: 'user', text }, { role: 'assistant', text: '' }])
        setDraft('')
        setBusy(true)
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: panelStore.get().sessionId,
              selection: panelStore.get().selection ?? '',
              question: text,
              history,
              contextLimit: CONTEXT_LIMITS[panelStore.get().contextMode] ?? 0,
            }),
            signal: controller.signal,
          })
          if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let index = buffer.indexOf('\n')
            while (index >= 0) {
              const line = buffer.slice(0, index).trim()
              buffer = buffer.slice(index + 1)
              index = buffer.indexOf('\n')
              if (line === '') continue
              let event
              try { event = JSON.parse(line) } catch { continue }
              if (event.t === 'delta' && typeof event.text === 'string') appendAssistant(event.text)
              else if (event.t === 'meta' && typeof event.context === 'number') {
                panelStore.setContext(
                  event.context,
                  typeof event.chars === 'number' ? event.chars : 0,
                  typeof event.from === 'number' ? event.from : 0,
                  typeof event.to === 'number' ? event.to : 0,
                )
              }
              else if (event.t === 'error') panelStore.fail(text, String(event.message ?? ''))
              else if (event.t === 'aborted') appendAssistant(`\n\n${t('aborted')}`)
            }
          }
        } catch (error) {
          if (error?.name !== 'AbortError') panelStore.fail(text, String(error?.message ?? error))
          else appendAssistant(`\n\n${t('aborted')}`)
        } finally {
          abortRef.current = null
          setBusy(false)
        }
      }, [appendAssistant, busy, t])

      const presets = useMemo(() => (selection === null ? [] : presetsOf(selection, t)), [selection, t])
      const lastError = current.error

      if (!visible) return null

      const quoteLines = (selection ?? '').split(/\r?\n/u)
      const quoteShown = expanded || quoteLines.length <= 4
        ? quoteLines.join('\n')
        : `${quoteLines.slice(0, 4).join('\n')}\n…`

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void ask(draft)
        } else if (event.key === 'Escape') {
          panelStore.close()
        }
      }

      return h('div', {
        ref: cardRef, className: 'sf-card',
        style: { ...styles.card, ...surface, ...placement },
        role: 'dialog', 'aria-label': t('title'),
      },
        h('style', { key: 'css' }, CARD_CSS),
        h('div', { style: styles.head },
          h('span', { style: styles.headTitle }, t('title')),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
            selection !== null
              ? h('button', {
                type: 'button', className: 'sf-quote-toggle', style: styles.quoteToggle,
                'aria-label': t('copy'), title: t('copy'),
                onClick: () => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
                    navigator.clipboard.writeText(selection).then(() => setCopied(true)).catch(() => {})
                  }
                },
              }, copied ? t('copied') : t('copy'))
              : null,
            selection !== null && !current.quoteOpen
              ? h('button', {
                type: 'button', className: 'sf-quote-toggle', style: styles.quoteToggle,
                'aria-label': t('showQuote'), title: t('showQuote'),
                onClick: () => panelStore.toggleQuote(),
              }, t('showQuote'))
              : null,
            h('button', {
              type: 'button', className: 'sf-close', style: styles.close,
              'aria-label': t('close'), title: t('close'),
              onClick: () => panelStore.close(),
            }, '×'))),
        selection !== null && current.quoteOpen ? h('div', {
          className: 'sf-quote',
          style: wallpaper ? { ...styles.quote, background: 'rgba(255, 255, 255, 0.06)' } : styles.quote,
        },
          h('div', { style: styles.quoteHead },
            h('span', null, t('quoteLabel')),
            quoteLines.length > 4
              ? h('button', {
                type: 'button', style: styles.linkButton,
                onClick: () => setExpanded(value => !value),
              }, t(expanded ? 'less' : 'more'))
              : null),
          h('pre', { style: styles.quoteText }, quoteShown)) : null,
        h('div', { ref: listRef, style: styles.turns },
          turns.length === 0
            ? h('div', { style: { color: COLORS.caption, fontSize: '12px', lineHeight: '18px' } }, t('thinking'))
            : turns.map((turn, index) => turn.role === 'user'
              ? h('div', { key: String(index), style: styles.userTurn }, turn.text)
              : h('div', { key: String(index), style: styles.assistantTurn },
                h('div', { style: styles.md }, renderMarkdown(turn.text))))),
        presets.length > 0
          ? h('div', { style: styles.chips }, presets.map(preset => h('button', {
            key: preset.id, type: 'button', className: 'sf-chip', style: styles.chip,
            onClick: () => { void ask(preset.prompt) },
          }, h('span', { key: 'label' }, preset.label),
          h('span', { key: 'arrow', style: styles.chipArrow }, '→'))))
          : null,
        lastError === null ? null : h('div', { key: 'error', style: styles.errorBox },
          h('span', { style: styles.errorText }, `${t('error')}: ${lastError.message}`),
          h('button', {
            type: 'button', style: styles.errorAction,
            onClick: () => { void ask(lastError.question) },
          }, t('retry')),
          h('button', {
            type: 'button', style: styles.errorDismiss,
            onClick: () => panelStore.clearError(),
          }, t('dismiss'))),
        current.contextMode !== 'selection' && current.contextCount === 0
          ? h('div', { key: 'no-context', style: styles.hint }, t('noContext'))
          : null,
        h('div', { style: styles.composer },
          h('div', { style: styles.modeRow },
            h('span', { style: styles.modeLabel }, t('contextLabel')),
            CONTEXT_MODES.map(mode => h('button', {
              key: mode, type: 'button',
              className: current.contextMode === mode ? 'sf-mode sf-mode-on' : 'sf-mode',
              style: current.contextMode !== mode
                ? styles.modeChip
                : !wallpaper
                  ? styles.modeChipActive
                  : {
                    ...styles.modeChipActive,
                    borderColor: ACCENT,
                    color: ACCENT,
                    background: `color-mix(in srgb, ${ACCENT} 16%, transparent)`,
                  },
              'aria-pressed': current.contextMode === mode,
              onClick: () => panelStore.setContextMode(mode),
            }, t(`context.${mode}`)))),
          h('textarea', {
            ref: inputRef,
            style: styles.textarea,
            value: draft,
            placeholder: t('placeholder'),
            onChange: event => setDraft(event.target.value),
            onKeyDown,
            rows: 2,
          }),
          h('div', { style: styles.composerRow },
            h('span', { style: styles.note }, current.contextMode === 'selection'
              ? t('noteSelection')
              : current.contextCount !== null && current.contextCount > 0
                ? t('contextNote')
                  .replace('{from}', String(current.contextFrom))
                  .replace('{to}', String(current.contextTo))
                  .replace('{n}', String(current.contextCount))
                  .replace('{c}', String(current.contextChars))
                : t('privateNote')),
            busy
              ? h('button', {
                type: 'button', className: 'sf-stop',
                style: wallpaper ? { ...styles.actionStop, background: ACCENT } : styles.actionStop,
                'aria-label': t('stop'), title: t('stop'),
                onClick: () => abortRef.current?.abort(),
              }, h('svg', {
                key: 'icon', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
                xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, focusable: 'false',
              }, h('rect', {
                x: 3.5, y: 3.5, width: 9, height: 9, rx: 2, fill: 'currentColor',
              })))
              : h('button', {
                type: 'button', className: 'sf-send',
                style: wallpaper ? { ...styles.action, background: ACCENT } : styles.action,
                'aria-label': t('send'), title: t('send'),
                disabled: draft.trim() === '',
                onClick: () => { void ask(draft) },
              }, h('svg', {
                key: 'icon', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
                xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, focusable: 'false',
              }, h('path', { d: SEND_ICON, fill: 'currentColor' }))))))
    }

    // --- plugin -----------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'uiConversation'],
      /**
       * Register the overlay card and the selection entry point.
       * @param ctx - client plugin context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'selection-followup: zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'selection-followup: en')
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: OVERLAY, locale: NS,
        }, FollowUpCard)), 'selection-followup: card')
        ctx.effect(() => ctx.uiConversation.interactions.register({
          id: INTERACTION,
          onInteraction(request) {
            if (request.trigger !== 'contextmenu' || !request.hasSelection) return
            const text = request.readText()
            if (text === null || text.trim() === '') return
            request.preventDefault()
            panelStore.open(request.sessionId, text, selectionAnchor())
          },
        }), 'selection-followup: entry')
      },
    }
  },
})



