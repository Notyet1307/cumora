import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { IntegrationConnection } from './bindings.js'

/** Server-only outbound/credential ceilings; never a connection configuration. */
export interface IntegrationTrustGrant {
  secretRef: string
  credentialRevision: string
  value: string
  companyIds: string[]
  backend: IntegrationConnection['backend']
  baseUrls: string[]
  knowledgeBaseIds: string[]
  remoteAgentIds: string[]
  toolNames: string[]
}

/** Inspect decoded strings too: JSON escaping must not hide a credential echo. */
export function hasIntegrationCredential(value: unknown, grants: readonly IntegrationTrustGrant[]): boolean {
  if (typeof value === 'string') return grants.some(grant => value.includes(grant.value))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => hasIntegrationCredential(key, grants) || hasIntegrationCredential(child, grants))
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/
const GRANT_KEYS = ['secretRef', 'credentialRevision', 'value', 'companyIds', 'backend', 'baseUrls', 'knowledgeBaseIds', 'remoteAgentIds', 'toolNames']
function reject(): never { throw new Error('invalid_integration_trust') }
function ids(value: unknown, nonempty = false): value is string[] {
  return Array.isArray(value) && value.length <= 128 && (!nonempty || value.length > 0)
    && value.every(v => typeof v === 'string' && SAFE_ID.test(v)) && new Set(value).size === value.length
}

export function isIntegrationLoopbackUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#]/.test(value)) return false
  try {
    const url = new URL(value)
    // Inspect the original authority as well: WHATWG normalizes integer/hex and
    // abbreviated IP addresses, which are not approved literal loopback hosts.
    return /^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(value)
      && ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export function validateIntegrationTrust(value: unknown): IntegrationTrustGrant[] {
  if (!Array.isArray(value) || value.length > 128) reject()
  const grants: IntegrationTrustGrant[] = []
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) reject()
    const grant = entry as Record<string, unknown>
    if (Object.keys(grant).length !== GRANT_KEYS.length || Object.keys(grant).some(key => !GRANT_KEYS.includes(key))
      || typeof grant.secretRef !== 'string' || typeof grant.credentialRevision !== 'string'
      || !SAFE_ID.test(grant.secretRef) || !SAFE_ID.test(grant.credentialRevision)
      || typeof grant.value !== 'string' || !grant.value.trim() || grant.value.length > 8192 || /[\r\n\0]/.test(grant.value)
      || (grant.backend !== 'weknora' && grant.backend !== 'a2a' && grant.backend !== 'mcp')
      || !ids(grant.companyIds, true) || !ids(grant.knowledgeBaseIds) || !ids(grant.remoteAgentIds) || !ids(grant.toolNames)
      || !Array.isArray(grant.baseUrls) || !grant.baseUrls.length || grant.baseUrls.length > 128
      || !grant.baseUrls.every(isIntegrationLoopbackUrl) || new Set(grant.baseUrls).size !== grant.baseUrls.length) reject()
    grants.push({ secretRef: grant.secretRef, credentialRevision: grant.credentialRevision, value: grant.value,
      backend: grant.backend, companyIds: [...grant.companyIds], knowledgeBaseIds: [...grant.knowledgeBaseIds],
      remoteAgentIds: [...grant.remoteAgentIds], toolNames: [...grant.toolNames], baseUrls: [...grant.baseUrls] })
  }
  const catalog = grants.map(grant => ({ ...grant, value: undefined }))
  if (hasIntegrationCredential(catalog, grants)) reject()
  // A credential identity may cover several tenants/resources but cannot name
  // two different secrets. No order-dependent grant selection is permitted.
  const values = new Map<string, string>()
  for (const grant of grants) {
    const key = JSON.stringify([grant.secretRef, grant.credentialRevision])
    if (values.has(key) && values.get(key) !== grant.value) reject()
    values.set(key, grant.value)
  }
  return grants
}

/** An absent file opts out; a configured but unsafe/missing file fails closed. */
export async function loadIntegrationTrust(path = process.env.CUMORA_INTEGRATION_TRUST_FILE): Promise<IntegrationTrustGrant[]> {
  if (!path) return []
  if (!isAbsolute(path)) reject()
  let file: FileHandle | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) reject()
    const text = await file.readFile('utf8')
    if (Buffer.byteLength(text) > 1024 * 1024) reject()
    const document: unknown = JSON.parse(text)
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || Object.keys(document).length !== 2 || !('schemaVersion' in document) || !('grants' in document)
      || document.schemaVersion !== 1) reject()
    return validateIntegrationTrust(document.grants)
  } catch { return reject() }
  finally { await file?.close().catch(() => {}) }
}
