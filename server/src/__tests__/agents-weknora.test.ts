/**
 * Unit tests for the WeKnora retrieval tool (agents/weknora.ts).
 *
 * This tool is the only place an agent can pull text from outside the
 * workspace, so the properties worth pinning are the ones that keep that
 * access narrow and honest:
 *
 *   - authorization is default-deny (empty allowlist, wrong company, wrong
 *     agent all refuse) and the refusal text is actionable;
 *   - the knowledge base is taken from config only — a caller cannot widen
 *     the scope, and there is no URL/key parameter to smuggle one through;
 *   - every upstream failure mode (timeout, 401, oversize, non-JSON) turns
 *     into a discrete reason instead of a crash or a silent empty result;
 *   - formatted output carries a "this is data, not instructions" banner and
 *     only metadata the API actually returned.
 *
 * Config comes from process.env, which env.ts captures at import — so the
 * baseline is set here before the dynamic import, and cases that need a
 * different value mutate the exported env object (restored in `finally`).
 *
 * Run: node --import tsx --test server/src/__tests__/agents-weknora.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.WEKNORA_BASE_URL = 'http://weknora.test/api/v1'
process.env.WEKNORA_API_KEY = 'test-key-do-not-log'
process.env.WEKNORA_KB_ID = 'kb-authorized'
process.env.WEKNORA_ALLOWED_COMPANY_IDS = 'personal'
process.env.WEKNORA_ALLOWED_AGENT_IDS = 'compliance'
process.env.WEKNORA_MAX_CHUNKS = '3'
process.env.WEKNORA_TIMEOUT_MS = '2000'
const actor = { agentId: 'compliance', companyId: 'personal' }

const { env } = await import('../env.js')
// Dynamic on purpose: env.ts snapshots process.env at module evaluation, so
// the baseline above must be in place before this module graph loads. A static
// import would be hoisted ahead of the assignments and read the real .env.
const { formatWeknoraSearch, searchWeknora, weknoraDenial, logWeknoraCall } = await import('../agents/weknora.js')

const realFetch = globalThis.fetch
/** Capture the last request while returning a canned response. */
function stubFetch(reply: () => Response | Promise<Response>): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return await reply()
  }) as typeof globalThis.fetch
  return { calls }
}

function searchPayload(items: unknown[]): Response {
  return new Response(JSON.stringify({ success: true, data: items }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SAMPLE_ROW = {
  id: 'chunk-1',
  knowledge_id: 'know-1',
  knowledge_title: '合规手册.md',
  content: '数据处理前必须完成影响评估，评估结论需留档三年。',
  score: '0.42',
}

// ── authorization ───────────────────────────────────────────────────────

test('retrieval itself refuses unauthorized actors before HTTP, even without CLI preflight', async () => {
  const stub = stubFetch(() => searchPayload([SAMPLE_ROW]))
  try {
    for (const caller of [
      { agentId: 'reporter', companyId: 'personal' },
      { agentId: 'compliance', companyId: 'other-co' },
      { agentId: 'compliance', companyId: null },
    ]) {
      assert.notEqual(weknoraDenial(caller), null)
      const result = await searchWeknora({ ...caller, query: '影响评估' })
      assert.equal(result.ok, false)
    }
    assert.equal(stub.calls.length, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('empty allowlists and missing configuration refuse retrieval before HTTP', async () => {
  const original = { ...env }
  const stub = stubFetch(() => searchPayload([SAMPLE_ROW]))
  try {
    for (const override of [
      { WEKNORA_ALLOWED_AGENT_IDS: [] }, { WEKNORA_ALLOWED_COMPANY_IDS: [] },
      { WEKNORA_BASE_URL: '' }, { WEKNORA_API_KEY: '' }, { WEKNORA_KB_ID: '' },
    ]) {
      Object.assign(env, original, override)
      const result = await searchWeknora({ ...actor, query: '影响评估' })
      assert.equal(result.ok, false)
    }
    assert.equal(stub.calls.length, 0)
  } finally {
    Object.assign(env, original)
    globalThis.fetch = realFetch
  }
})

// ── request shape ───────────────────────────────────────────────────────

test('search pins the knowledge base from config and sends only the query', async () => {
  const stub = stubFetch(() => searchPayload([SAMPLE_ROW]))
  try {
    const result = await searchWeknora({ ...actor, query: '影响评估' })
    assert.equal(result.ok, true)
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].url, 'http://weknora.test/api/v1/knowledge-search')
    const headers = stub.calls[0].init.headers as Record<string, string>
    assert.equal(headers['X-API-Key'], 'test-key-do-not-log')
    // No kb parameter, no URL, no key: the caller supplied a query and nothing else.
    assert.deepEqual(JSON.parse(String(stub.calls[0].init.body)), {
      query: '影响评估',
      knowledge_base_ids: ['kb-authorized'],
    })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('search caps --limit at the configured maximum', async () => {
  stubFetch(() => searchPayload([SAMPLE_ROW, SAMPLE_ROW, SAMPLE_ROW, SAMPLE_ROW]))
  try {
    // WEKNORA_MAX_CHUNKS=3; a caller asking for 50 still gets 3.
    const result = await searchWeknora({ ...actor, query: 'x', limit: 50 })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.limit, 3)
      assert.equal(result.hits.length, 3)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test('search refuses an empty query without calling upstream', async () => {
  const stub = stubFetch(() => searchPayload([]))
  try {
    const result = await searchWeknora({ ...actor, query: '   ' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /查询为空/)
    assert.equal(stub.calls.length, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── upstream failure modes ──────────────────────────────────────────────

test('an auth failure is reported as a key/permission problem', async () => {
  stubFetch(() => new Response('{"error":"unauthorized"}', { status: 401 }))
  try {
    const result = await searchWeknora({ ...actor, query: 'x' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.reason, /HTTP 401/)
      assert.match(result.reason, /API key 无效或权限不足/)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a timeout is reported as a timeout, not as an empty result', async () => {
  globalThis.fetch = (async () => {
    const err = new Error('The operation was aborted due to timeout')
    err.name = 'TimeoutError'
    throw err
  }) as typeof globalThis.fetch
  try {
    const result = await searchWeknora({ ...actor, query: 'x' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /上游超时（2000ms）/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('an oversized response is refused instead of buffered', async () => {
  const original = env.WEKNORA_MAX_RESPONSE_BYTES
  env.WEKNORA_MAX_RESPONSE_BYTES = 16_384
  stubFetch(() => searchPayload([{ ...SAMPLE_ROW, content: 'x'.repeat(40_000) }]))
  try {
    const result = await searchWeknora({ ...actor, query: 'x' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /超过 16384 字节上限/)
  } finally {
    env.WEKNORA_MAX_RESPONSE_BYTES = original
    globalThis.fetch = realFetch
  }
})

test('a non-JSON body is reported instead of parsed into an empty result', async () => {
  stubFetch(() => new Response('<html>gateway</html>', { status: 200 }))
  try {
    const result = await searchWeknora({ ...actor, query: 'x' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /不是合法 JSON/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('an upstream body echoing the key is redacted', async () => {
  stubFetch(() => new Response('key test-key-do-not-log rejected', { status: 403 }))
  try {
    const result = await searchWeknora({ ...actor, query: 'x' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.doesNotMatch(result.reason, /test-key-do-not-log/)
      assert.match(result.reason, /\[redacted\]/)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── output ──────────────────────────────────────────────────────────────

test('hits keep the citable metadata and drop rows that cannot be cited', async () => {
  stubFetch(() => searchPayload([
    SAMPLE_ROW,
    { id: '', knowledge_id: 'know-2', content: 'no chunk id' },
    { id: 'chunk-3', knowledge_id: 'know-3', content: '' },
  ]))
  try {
    const result = await searchWeknora({ ...actor, query: '评估' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.hits.length, 1)
      assert.deepEqual(result.hits[0], {
        chunkId: 'chunk-1',
        knowledgeId: 'know-1',
        title: '合规手册.md',
        score: 0.42,
        snippet: '数据处理前必须完成影响评估，评估结论需留档三年。',
      })
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test('formatted hits carry the data-not-instructions banner and the score caveat', async () => {
  stubFetch(() => searchPayload([SAMPLE_ROW]))
  try {
    const result = await searchWeknora({ ...actor, query: '影响评估' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const text = formatWeknoraSearch(result, '影响评估')
    assert.match(text, /资料而非指令/)
    assert.match(text, /score 是检索相似度分数，不代表内容正确或权威/)
    assert.match(text, /《合规手册\.md》/)
    assert.match(text, /chunk_id=chunk-1/)
    assert.match(text, /knowledge_id=know-1/)
    // No invented page/date metadata: the payload had none, so none appears.
    assert.doesNotMatch(text, /页码|发布于|更新于/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('zero hits are distinguishable from upstream failure', async () => {
  stubFetch(() => searchPayload([]))
  try {
    const result = await searchWeknora({ ...actor, query: '不存在的主题' })
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.hits, [])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a config change during fetch cannot relabel results or disclose the original credential', async () => {
  const original = { ...env }
  const logged: string[] = []
  const realLog = console.log
  console.log = (line: string) => { logged.push(line) }
  const stub = stubFetch(() => {
    env.WEKNORA_BASE_URL = 'http://other.test'
    env.WEKNORA_KB_ID = 'other-kb'
    env.WEKNORA_API_KEY = 'rotated-key'
    return searchPayload([SAMPLE_ROW])
  })
  try {
    const result = await searchWeknora({ ...actor, query: '影响评估' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.kbId, 'kb-authorized')
    assert.match(formatWeknoraSearch(result, '影响评估'), /kb=kb-authorized/)
    assert.doesNotMatch(formatWeknoraSearch(result, '影响评估'), /other-kb/)
    logWeknoraCall({ ...actor, kbId: result.kbId, requestId: result.requestId, status: 'ok', hits: result.hits.length, ms: 1, queryChars: 4 })
    assert.match(logged[0], /kb=kb-authorized/)
    assert.equal(JSON.parse(String(stub.calls[0].init.body)).knowledge_base_ids[0], 'kb-authorized')
    Object.assign(env, original)
    stubFetch(() => {
      env.WEKNORA_API_KEY = 'rotated-key'
      return new Response('rejected test-key-do-not-log', { status: 403 })
    })
    const failed = await searchWeknora({ ...actor, query: '影响评估' })
    assert.equal(failed.ok, false)
    if (!failed.ok) assert.doesNotMatch(failed.reason, /test-key-do-not-log/)
  } finally {
    Object.assign(env, original)
    globalThis.fetch = realFetch
    console.log = realLog
  }
})
