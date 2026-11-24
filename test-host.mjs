/**
 * Offline smoke test for the host half: no DSH runtime, no network.
 * Run with the bundled Node: `ELECTRON_RUN_AS_NODE=1 node test-host.mjs`
 */
import { apply } from './index.js'

const routes = []
const requests = []

const ctx = {
  effect(register, _label) {
    const disposer = register()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  connection: {
    fetch: {
      register(route) {
        routes.push(route)
        return async () => {}
      },
    },
  },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }),
  },
  llm: {
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '你好，' }
      yield { type: 'text-delta', index: 0, text: '这是一段测试回答。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  sessions: {
    get: () => ({
      deriveMessages: () => [
        { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
        { role: 'user', content: [{ type: 'text', text: '上一个问题' }] },
        { role: 'assistant', content: '上一条回答（纯字符串内容）' },
        { role: 'user', content: [{ type: 'text', text: '再上一个问题' }] },
        { role: 'assistant', content: [{ type: 'text', text: '更早的回答' }] },
      ],
    }),
  },
}

apply(ctx)

if (routes.length !== 1) throw new Error(`expected one route, got ${routes.length}`)
const route = routes[0]
if (route.path !== '/api/selection-followup/ask') throw new Error(`unexpected path ${route.path}`)
if (route.requestBody !== 'buffered') throw new Error('expected buffered body')

// A second activation must not register the route again (the slot is process-wide).
apply(ctx)
if (routes.length !== 1) throw new Error(`second activation registered the route again: ${routes.length}`)

async function ask(body) {
  const response = await route.fetch(new Request('http://local/api/selection-followup/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const text = await response.text()
  return { status: response.status, lines: text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

const requestText = (options) => options.messages
  .flatMap(message => message.content)
  .map(block => block.text ?? '')
  .join('\n')

// --- context requested --------------------------------------------------
const ok = await ask({ sessionId: 's1', selection: 'const a = 1', question: '这是什么？', contextLimit: 10 })
if (ok.status !== 200) throw new Error(`status ${ok.status}`)
const deltas = ok.lines.filter(line => line.t === 'delta').map(line => line.text).join('')
if (deltas !== '你好，这是一段测试回答。') throw new Error(`bad deltas: ${deltas}`)
if (ok.lines.at(-1).t !== 'done') throw new Error('missing done event')

const meta = ok.lines.find(line => line.t === 'meta')
if (meta === undefined) throw new Error('missing context meta event')
if (meta.context !== 4) throw new Error(`context messages wrong: ${meta.context}`)
if (!(meta.chars > 0)) throw new Error('context characters were not reported')
if (meta.from !== 1 || meta.to !== 2) throw new Error(`question range wrong: ${meta.from}-${meta.to}`)

const sent = requests.at(-1)
if (sent.provider !== 'fake-provider') throw new Error('wrong provider')
if (!sent.system) throw new Error('missing system prompt')
if (sent.messages.length !== 1) throw new Error('expected one user message')
const only = sent.messages[0]
if (only.role !== 'user') throw new Error('the request message must be a user message')
if (only.source !== undefined) throw new Error('a user request message must not carry a source')
const text = requestText(sent)
if (!text.includes('Q1: 上一个问题')) throw new Error('context was not numbered in the request')
if (!text.includes('纯字符串内容')) throw new Error('string message content was dropped')
if (!text.includes('> const a = 1')) throw new Error('selection was not quoted')
if (!text.includes('Question: 这是什么？')) throw new Error('question missing from the request')

// --- context not requested ---------------------------------------------
const bare = await ask({ sessionId: 's1', selection: 'const a = 1', question: '只看引用', contextLimit: 0 })
const bareMeta = bare.lines.find(line => line.t === 'meta')
if (bareMeta === undefined || bareMeta.context !== 0) throw new Error('context should be empty when not requested')
if (requestText(requests.at(-1)).includes('Q1: 上一个问题')) throw new Error('context leaked despite contextLimit 0')
if (bare.lines.at(-1).t !== 'done') throw new Error('missing done event without context')

// --- failures -----------------------------------------------------------
const empty = await ask({ sessionId: 's1', selection: 'x', question: '   ' })
if (empty.lines[0].t !== 'error') throw new Error('empty question should report an error event')

const bad = await route.fetch(new Request('http://local/api/selection-followup/ask', { method: 'POST', body: 'not json' }))
if (bad.status !== 400) throw new Error(`bad body status ${bad.status}`)

const wrongMethod = await route.fetch(new Request('http://local/api/selection-followup/ask', { method: 'GET' }))
if (wrongMethod.status !== 405) throw new Error(`wrong method status ${wrongMethod.status}`)

// A host that already holds this path (left behind by an earlier activation)
// must not turn into a failed activation.
const orphan = {
  ...ctx,
  connection: {
    fetch: {
      register() { throw new Error('connection: exact Fetch route "/api/selection-followup/ask" is already registered') },
    },
  },
}
apply(orphan)

console.log('host smoke test: ok')
