/**
 * Host half of the selection follow-up plugin.
 *
 * Serves one exact `/api/selection-followup/ask` route: it assembles a small
 * context (the selection, at most a few recent conversation messages, the
 * caller's question), streams one model answer back as newline-delimited JSON,
 * and never touches the Session log.
 */

/** Host services this plugin needs. */
export const inject = ['connection', 'llm', 'agentDefaultModel', 'sessions']

/** Exact path below `/api`; the Client calls exactly this path. */
const ASK_PATH = '/api/selection-followup/ask'

/**Process-wide slot that lets a reloaded activation take over the one route. */
const BRIDGE_KEY = Symbol.for('@local/selection-followup/route')

/** Maximum characters kept from the selection. */
const SELECTION_LIMIT = 4000

/** Maximum characters kept from the question. */
const QUESTION_LIMIT = 2000

/** How many recent conversation messages accompany the selection. */
const CONTEXT_MESSAGES = 40

/** Maximum characters kept from one context message. */
const CONTEXT_MESSAGE_LIMIT = 4000

/** Total characters of conversation context allowed in one request. */
const CONTEXT_BUDGET = 12000

/** Turning count kept from the in-panel conversation. */
const HISTORY_TURNS = 8

/** Instruction prepended to every follow-up request. */
const SYSTEM_PROMPT = [
  'You answer a follow-up question about an excerpt the user selected in a larger conversation.',
  'The user message contains: the recent conversation messages (context only), the excerpt as a Markdown blockquote, and the question.',
  'When the question refers to earlier questions or answers, read them from the context list and answer from it; never claim you cannot see the conversation unless the context list is absent.',
  'Answer in the language of the question, directly and concisely: at most about 150 words unless the user asks for depth.',
  'Open with the answer itself, not a restatement of the question. Prefer short paragraphs or a short list over long prose.',
  'You may use Markdown (bold, lists, code fences); avoid tables and headings for short answers.',
  'Never mention tools, files, or processes you do not have; you cannot read files or run commands here.',
].join(' ')

/**
 * Join the text of one message, tolerating every shape a message may carry.
 * @param content - message content: block array, plain string, or `{ text }`.
 * @returns concatenated text, or an empty string.
 */
function blocksToText(content) {
  if (typeof content === 'string') return content.trim()
  if (content === null || typeof content !== 'object') return ''
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') { parts.push(block); continue }
      if (block !== null && typeof block === 'object' && block.type === 'text'
        && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }
  return typeof content.text === 'string' ? content.text.trim() : ''
}

/**
 * Number the conversation by question so "the Nth question" is addressable.
 * @param session - the live Session, or undefined.
 * @returns ordered `{ role, text, q }` entries, possibly empty.
 */
function conversationEntries(session) {
  if (session === undefined || session === null) return []
  if (typeof session.deriveMessages !== 'function') return []
  const entries = []
  let question = 0
  for (const message of session.deriveMessages()) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = blocksToText(message.content).slice(0, CONTEXT_MESSAGE_LIMIT)
    if (text === '') continue
    if (role === 'user') question += 1
    entries.push({ role, text, q: question })
  }
  return entries
}

/**
 * Take the newest conversation entries within the message and character budget.
 * @param entries - numbered conversation entries.
 * @param limit - how many trailing messages to consider.
 * @returns the trailing `{ role, text, q }` entries, oldest first.
 */
function recentMessages(entries, limit) {
  const picked = []
  let used = 0
  for (let index = entries.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const entry = entries[index]
    if (used + entry.text.length > CONTEXT_BUDGET) break
    used += entry.text.length
    picked.push(entry)
  }
  return picked.reverse()
}

/**
 * Build the request messages for one follow-up turn.
 *
 * Only a `user` request message may omit `source`/`id`, so context and history
 * are folded into the one user text instead of fabricating assistant messages
 * (which makes the adapter read `source.replayState` off undefined).
 * @param context - recent conversation messages.
 * @param history - earlier turns of this panel conversation.
 * @param selection - selected excerpt.
 * @param question - caller's question.
 * @returns request messages for `llm.stream`.
 */
function buildMessages(context, history, selection, question) {
  const lines = []
  if (context.length > 0) {
    lines.push('Recent messages from the main conversation, oldest first. Each question is numbered; “第 N 个问题” means Q N.')
    if (context[0].q > 1) lines.push(`(Questions before Q${context[0].q} are not included.)`)
    for (const entry of context) {
      lines.push(`${entry.role === 'user' ? `Q${entry.q}` : `A${entry.q}`}: ${entry.text}`)
    }
    lines.push('')
  }
  lines.push('The excerpt the user selected:')
  for (const line of selection.split(/\r?\n/u)) lines.push(`> ${line}`)
  lines.push('')
  if (history.length > 0) {
    lines.push('Earlier in this follow-up panel:')
    for (const turn of history) {
      lines.push(`${turn.role === 'user' ? 'Q' : 'A'}: ${turn.text}`)
    }
    lines.push('')
  }
  lines.push(`Question: ${question}`)
  return [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }]
}

/**
 * Normalize one in-panel turn.
 * @param turn - untrusted turn value.
 * @returns a usable turn, or undefined.
 */
function normalizeTurn(turn) {
  if (turn === null || typeof turn !== 'object') return undefined
  const role = turn.role === 'assistant' ? 'assistant' : 'user'
  const text = typeof turn.text === 'string' ? turn.text.trim() : ''
  if (text === '') return undefined
  return { role, text: text.slice(0, QUESTION_LIMIT) }
}

/**
 * Stream one answer as newline-delimited JSON events.
 * @param ctx - host context.
 * @param input - decoded request body.
 * @param signal - request cancellation.
 * @returns a streamed response.
 */
function streamAnswer(ctx, input, signal) {
  const encoder = new TextEncoder()
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  const selection = (typeof input.selection === 'string' ? input.selection : '').slice(0, SELECTION_LIMIT)
  const question = (typeof input.question === 'string' ? input.question : '').trim().slice(0, QUESTION_LIMIT)
  const history = Array.isArray(input.history)
    ? input.history.map(normalizeTurn).filter(turn => turn !== undefined).slice(-HISTORY_TURNS)
    : []
  const body = new ReadableStream({
    async start(controller) {
      const emit = (event) => { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) }
      try {
        if (question === '') {
          emit({ t: 'error', message: 'empty question' })
          return
        }
        const selection_ = ctx.agentDefaultModel.currentSelection()
        if (selection_ === undefined || selection_ === null || typeof selection_.provider !== 'string'
          || typeof selection_.model !== 'string') {
          emit({ t: 'error', message: 'no model selected in this session' })
          return
        }
        const session = sessionId === '' ? undefined : ctx.sessions.get(sessionId)
        const requested = typeof input.contextLimit === 'number' && Number.isFinite(input.contextLimit)
          ? Math.max(0, Math.min(Math.floor(input.contextLimit), CONTEXT_MESSAGES))
          : 0
        const context = requested === 0
          ? []
          : recentMessages(conversationEntries(session), requested)
        const messages = buildMessages(context, history, selection, question)
        emit({
          t: 'meta',
          context: context.length,
          chars: context.reduce((total, entry) => total + entry.text.length, 0),
          from: context.length > 0 ? context[0].q : 0,
          to: context.length > 0 ? context[context.length - 1].q : 0,
        })
        const options = {
          provider: selection_.provider,
          model: selection_.model,
          system: SYSTEM_PROMPT,
          messages,
          signal,
        }
        if (typeof selection_.reasoningEffort === 'string') options.reasoningEffort = selection_.reasoningEffort
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === 'text-delta') emit({ t: 'delta', text: chunk.text })
          else if (chunk.type === 'finish') {
            const reason = chunk.reason
            if (reason !== null && typeof reason === 'object' && reason.kind === 'error') {
              emit({ t: 'error', message: reason.failure?.message ?? 'model request failed' })
            } else if (reason !== null && typeof reason === 'object' && reason.kind === 'aborted') {
              emit({ t: 'aborted' })
            }
            break
          }
        }
        emit({ t: 'done' })
      } catch (error) {
        emit({ t: 'error', message: String(error?.message ?? error) })
      } finally {
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Handle one ask request.
 * @param ctx - host context.
 * @param request - Fetch request over `/api`.
 * @returns the streamed answer, or a JSON error.
 */
async function handleAsk(ctx, request) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 })
  }
  let input
  try {
    input = await request.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (input === null || typeof input !== 'object') {
    return Response.json({ error: 'invalid request body' }, { status: 400 })
  }
  return streamAnswer(ctx, input, request.signal)
}

/**
 * Register the exact ask route for the lifetime of this plugin.
 *
 * Reloading a plugin can leave a route behind: an activation that fails after
 * registering it, or a disposal that races a re-enable, makes the next
 * `register()` throw `already registered` and the whole entry fails to
 * activate. The route is therefore registered once per process and delegates to
 * whichever activation is live, so enable/disable cycles stay idempotent.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const host = globalThis
  const bridge = host[BRIDGE_KEY] ?? (host[BRIDGE_KEY] = { handler: null, registered: false })
  bridge.handler = request => handleAsk(ctx, request)
  ctx.effect(() => {
    if (!bridge.registered) {
      const delegated = (request) => {
        const handler = bridge.handler
        if (handler === null) {
          return Response.json({ error: 'selection follow-up is not active' }, { status: 503 })
        }
        return handler(request)
      }
      try {
        ctx.connection.fetch.register({
          path: ASK_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: delegated,
        })
        bridge.registered = true
      } catch (error) {
        // A route left by an earlier activation already answers this path.
        if (!/already registered/u.test(String(error?.message ?? error))) throw error
        bridge.registered = true
      }
    }
    return () => { bridge.handler = null }
  }, 'selection-followup: ask route')
}
