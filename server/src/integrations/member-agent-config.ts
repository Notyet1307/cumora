import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { BindingResolver, type BindingConfig } from './bindings.js'

/** Explicit operator-owned 0600 JSON, never a client path or a fallback R1/admin credential. */
export function loadMemberAgentBindings(path: string | undefined): BindingResolver | undefined {
  if (!path) return undefined
  if (!isAbsolute(path)) throw new Error('operator_config_absolute_path_required')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw new Error('operator_private_config_required')
    const value = JSON.parse(readFileSync(fd, 'utf8')) as { bindingConfig: BindingConfig; secrets: Record<string, string> }
    if (!value || !value.secrets || typeof value.secrets !== 'object' || Array.isArray(value.secrets)
      || !Object.values(value.secrets).every(secret => typeof secret === 'string' && secret.length > 0)
      || !Array.isArray(value.bindingConfig?.connections) || value.bindingConfig.connections.some(c => c.kind !== 'agent-service')) throw new Error('operator_agent_snapshot_required')
    return new BindingResolver(value.bindingConfig, value.secrets)
  } finally { closeSync(fd) }
}
