import { AGENT_LIMITS } from './weknora-agent.js'

/** Operator-selected loopback endpoints only; no redirects, cookies, or unbounded protocol bodies. */
export function createProtocolFetch(baseUrl: string, apiKey: string, authorize: () => void | Promise<void>, signal: AbortSignal,
  paths: readonly string[] = [new URL(baseUrl).pathname]): typeof fetch {
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || !apiKey) throw new Error('protocol_endpoint_denied')
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== base.origin || !paths.includes(url.pathname) || url.search || url.hash
      || !['GET', 'POST', 'DELETE'].includes(request.method)) throw new Error('protocol_target_denied')
    const boundedSignal = AbortSignal.any([signal, request.signal])
    boundedSignal.throwIfAborted()
    await authorize()
    boundedSignal.throwIfAborted()
    const headers = new Headers(request.headers)
    headers.set('Authorization', `Bearer ${apiKey}`)
    const response = await fetch(request, { headers, signal: boundedSignal, redirect: 'error', credentials: 'omit' })
    if (!response.body) {
      await authorize()
      boundedSignal.throwIfAborted()
      return response
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > AGENT_LIMITS.responseBytes) throw new Error('protocol_response_too_large')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const bytes = Buffer.concat(chunks, size)
    if (bytes.includes(Buffer.from(apiKey))) throw new Error('credential_in_remote_payload')
    await authorize()
    boundedSignal.throwIfAborted()
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
