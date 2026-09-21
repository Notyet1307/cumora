import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '@/api/client'
import type { BindingConfig, IntegrationBinding, IntegrationConnection, IntegrationManagementView, IntegrationProbeResult, IntegrationTarget } from '@/integration-types'
import { useLocale, useT } from '@/lib/i18n'
import { useParticipants } from '@/stores/participants'

const inputClass = 'mt-1 w-full min-w-0 rounded-[8px] border border-ink-100 bg-paper px-3 py-2 text-[12px] text-ink-800 focus:border-skype disabled:opacity-50'
const buttonClass = 'rounded-[8px] border border-ink-100 px-3 py-2 text-[12px] font-semibold text-ink-600 hover:bg-cloud disabled:opacity-40'
const primaryClass = 'rounded-[8px] bg-skype px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40'
const cardClass = 'min-w-0 rounded-[10px] border border-ink-100 bg-paper p-3'
const idPattern = '[A-Za-z0-9._:\\-]{1,128}'
const knowledgeTools = ['knowledge_search', 'grep_chunks', 'list_knowledge_chunks', 'query_knowledge_graph', 'get_document_info']
type View = 'connections' | 'authorizations' | 'activity' | 'history'
type Editor = { kind: 'connection'; value?: IntegrationConnection } | { kind: 'binding'; value?: IntegrationBinding }

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 text-[11.5px] font-medium text-ink-500">{label}{children}</label>
}

function targetMatches(target: IntegrationTarget, connection: IntegrationConnection, binding?: IntegrationBinding) {
  return target.backend === connection.backend && target.baseUrl === connection.baseUrl
    && target.secretRef === connection.secretRef && target.credentialRevision === connection.credentialRevision
    && connection.knowledgeBaseIds.every((id) => target.knowledgeBaseIds.includes(id))
    && (!binding || (binding.capabilityId === 'mcp.tools'
      ? binding.tools.every((tool) => target.toolNames.includes(tool.name))
      : binding.kind === 'agent-service' && target.remoteAgentIds.includes(binding.remoteAgentId)
        && (binding.capabilityId !== 'weknora.agent' || binding.approval?.allowedTools.every((tool) => target.toolNames.includes(tool)))))
}

function ConnectionForm({ connection, view, busy, onSave, onCancel }: {
  connection?: IntegrationConnection
  view: IntegrationManagementView
  busy: boolean
  onSave: (connection: IntegrationConnection) => void
  onCancel: () => void
}) {
  const t = useT()
  const firstInput = useRef<HTMLInputElement>(null)
  useEffect(() => { firstInput.current?.focus() }, [])
  const [id, setId] = useState(connection?.id ?? '')
  const [targetIndex, setTargetIndex] = useState(() => {
    const index = connection ? view.targets.findIndex((target) => targetMatches(target, connection)) : -1
    return index < 0 ? '' : String(index)
  })
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState(connection?.knowledgeBaseIds ?? [])
  const [enabled, setEnabled] = useState(connection?.enabled ?? false)
  const target = targetIndex === '' ? undefined : view.targets[Number(targetIndex)]
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!target) return
    onSave({ id, version: 'pending', kind: target.backend === 'mcp' ? 'tool' : 'agent-service',
      backend: target.backend, baseUrl: target.baseUrl, secretRef: target.secretRef,
      credentialRevision: target.credentialRevision, knowledgeBaseIds, enabled })
  }
  return (
    <form onSubmit={submit} className={`${cardClass} space-y-3`} aria-label={t(connection ? 'integrations.editConnection' : 'integrations.addConnection')}>
      <h4 className="text-[13px] font-semibold text-ink-800">{t(connection ? 'integrations.editConnection' : 'integrations.addConnection')}</h4>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <Field label={t('integrations.connectionId')}>
          <input ref={firstInput} className={inputClass} required pattern={idPattern} maxLength={128} value={id} readOnly={!!connection} onChange={(event) => setId(event.target.value)} />
        </Field>
        <Field label={t('integrations.target')}>
          <select className={inputClass} required value={targetIndex} onChange={(event) => { setTargetIndex(event.target.value); setKnowledgeBaseIds([]) }}>
            <option value="">{t('integrations.chooseTarget')}</option>
            {view.targets.map((item, index) => <option key={index} value={index}>
              {index + 1} · {item.backend} · {item.baseUrl} · {item.secretRef} / {item.credentialRevision}
            </option>)}
          </select>
        </Field>
        <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.targetHelp')}</p>
        {!view.targets.length && <p className="text-[12px] text-coral-deep">{t('integrations.noTargets')}</p>}
        {connection && !target && <p className="text-[12px] text-coral-deep">{t('integrations.targetUnavailable')}</p>}
        {target && <dl className="grid min-w-0 grid-cols-1 gap-2 rounded-[8px] bg-cloud/60 p-3 text-[11px] sm:grid-cols-2">
          <div className="min-w-0 sm:col-span-2"><dt className="text-ink-400">{t('integrations.endpoint')}</dt><dd className="break-all text-ink-700">{target.baseUrl}</dd></div>
          <div className="min-w-0"><dt className="text-ink-400">{t('integrations.secretRef')}</dt><dd className="break-all text-ink-700">{target.secretRef}</dd></div>
          <div className="min-w-0"><dt className="text-ink-400">{t('integrations.credentialRevision')}</dt><dd className="break-all text-ink-700">{target.credentialRevision}</dd></div>
        </dl>}
        {target?.backend === 'weknora' && <fieldset className="min-w-0">
          <legend className="text-[11.5px] font-medium text-ink-500">{t('integrations.knowledgeBases')}</legend>
          {!target.knowledgeBaseIds.length && <p className="mt-1 text-[11px] text-coral-deep">{t('integrations.noResources')}</p>}
          <div className="mt-1 grid min-w-0 gap-2 sm:grid-cols-2">{target.knowledgeBaseIds.map((resource) => (
            <label key={resource} className="flex min-w-0 items-start gap-2 text-[12px] text-ink-700">
              <input type="checkbox" className="mt-0.5 shrink-0" checked={knowledgeBaseIds.includes(resource)} onChange={(event) => setKnowledgeBaseIds(event.target.checked ? [...knowledgeBaseIds, resource] : knowledgeBaseIds.filter((id) => id !== resource))} />
              <span className="break-all">{resource}</span>
            </label>
          ))}</div>
        </fieldset>}
        <label className="flex items-start gap-2 text-[12px] text-ink-700"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t('integrations.enabledAfterSave')}</label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryClass} disabled={!target || (target.backend === 'weknora' && !knowledgeBaseIds.length)}>{t('common.save')}</button>
          <button type="button" className={buttonClass} onClick={onCancel}>{t('common.cancel')}</button>
        </div>
      </fieldset>
    </form>
  )
}

function parseSchema(value: string): Record<string, unknown> {
  const schema: unknown = JSON.parse(value)
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !('type' in schema) || schema.type !== 'object') throw new Error('invalid_schema')
  return schema as Record<string, unknown>
}

function BindingForm({ binding, view, companyId, busy, onSave, onCancel }: {
  binding?: IntegrationBinding
  view: IntegrationManagementView
  companyId: string
  busy: boolean
  onSave: (binding: IntegrationBinding) => void
  onCancel: () => void
}) {
  const t = useT()
  const firstInput = useRef<HTMLInputElement>(null)
  useEffect(() => { firstInput.current?.focus() }, [])
  const approval = binding?.kind === 'agent-service' ? binding.approval : undefined
  const [id, setId] = useState(binding?.id ?? '')
  const [connectionId, setConnectionId] = useState(binding?.connectionId ?? '')
  const [memberId, setMemberId] = useState(binding?.subjectIds[0] ?? '')
  const [enabled, setEnabled] = useState(binding?.enabled ?? false)
  const [remoteAgentId, setRemoteAgentId] = useState(binding?.kind === 'agent-service' ? binding.remoteAgentId : '')
  const [tenantId, setTenantId] = useState(approval?.tenantId ?? '')
  const [digest, setDigest] = useState(approval?.effectiveConfigDigest ?? '')
  const [allowedTools, setAllowedTools] = useState(binding?.capabilityId === 'weknora.agent' ? binding.approval?.allowedTools ?? [] : [])
  const [mcpSelectionMode, setMcpSelectionMode] = useState<'none' | 'all'>(binding?.capabilityId === 'weknora.agent' ? binding.approval?.mcpSelectionMode ?? 'none' : 'none')
  const [tools, setTools] = useState(() => binding?.capabilityId === 'mcp.tools' ? binding.tools.map((tool) => ({
    name: tool.name, inputSchema: JSON.stringify(tool.inputSchema, null, 2), outputSchema: tool.outputSchema ? JSON.stringify(tool.outputSchema, null, 2) : '',
  })) : [])
  const [reviewed, setReviewed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scopeIndex, setScopeIndex] = useState(() => {
    const savedConnection = view.config.connections.find((item) => item.id === binding?.connectionId)
    const index = savedConnection && binding ? view.targets.findIndex((item) => targetMatches(item, savedConnection, binding)) : -1
    return index < 0 ? '' : String(index)
  })
  const connection = view.config.connections.find((item) => item.id === connectionId)
  const scopes = connection ? view.targets.map((target, index) => ({ target, index })).filter(({ target }) => targetMatches(target, connection)
    && view.config.bindings.every((item) => item.connectionId !== connection.id || item.id === binding?.id || targetMatches(target, connection, item))) : []
  const scope = scopes.length === 1 ? scopes[0] : scopes.find((item) => String(item.index) === scopeIndex)
  const target = scope?.target
  const isMcp = connection?.backend === 'mcp'
  const members = view.members.filter((member) => member.executionKind === (isMcp ? 'native' : 'external-service')
    && !view.config.bindings.some((item) => item.id !== binding?.id && item.subjectIds.includes(member.id)))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!connection || !target || !reviewed) return
    const base = { id, version: 'pending', connectionId, connectionVersion: connection.version, companyIds: [companyId], subjectIds: [memberId], enabled }
    if (connection.backend === 'mcp') {
      try {
        onSave({ ...base, kind: 'tool', capabilityId: 'mcp.tools', tools: tools.map((tool) => ({ name: tool.name, readOnly: true,
          inputSchema: parseSchema(tool.inputSchema), ...(tool.outputSchema.trim() ? { outputSchema: parseSchema(tool.outputSchema) } : {}) })) })
      } catch { setError(t('integrations.invalidSchema')) }
    } else if (connection.backend === 'a2a') {
      onSave({ ...base, kind: 'agent-service', capabilityId: 'a2a.agent', remoteAgentId,
        approval: { authorizationVersion: 'pending', tenantId, effectiveConfigDigest: digest, cardSha256: digest, protocolVersion: '0.3.0' } })
    } else {
      onSave({ ...base, kind: 'agent-service', capabilityId: 'weknora.agent', remoteAgentId,
        approval: { authorizationVersion: 'pending', tenantId, effectiveConfigDigest: digest, mode: 'smart-reasoning', allowedTools,
          credentialCapability: 'chat', kbSelectionMode: 'selected', retrieveKbOnlyWhenMentioned: false, mcpSelectionMode,
          ...(mcpSelectionMode === 'all' ? { mcpEnabledServiceIds: [] } : {}), skillsSelectionMode: 'none', sandboxEnabled: false, memoryEnabled: false } })
    }
  }
  return (
    <form onSubmit={submit} onChange={() => { setReviewed(false); setError(null) }} className={`${cardClass} space-y-3`} aria-label={t(binding ? 'integrations.editBinding' : 'integrations.addBinding')}>
      <h4 className="text-[13px] font-semibold text-ink-800">{t(binding ? 'integrations.editBinding' : 'integrations.addBinding')}</h4>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <Field label={t('integrations.bindingId')}><input ref={firstInput} className={inputClass} required pattern={idPattern} maxLength={128} value={id} readOnly={!!binding} onChange={(event) => setId(event.target.value)} /></Field>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field label={t('integrations.connection')}>
            <select className={inputClass} value={connectionId} required onChange={(event) => { setConnectionId(event.target.value); setScopeIndex(''); setMemberId(''); setRemoteAgentId(''); setAllowedTools([]); setTools([]); setDigest(''); setTenantId('') }}>
              <option value="">{t('integrations.chooseConnection')}</option>
              {view.config.connections.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.backend}{item.enabled ? '' : ` · ${t('integrations.disabled')}`}</option>)}
            </select>
          </Field>
          <Field label={t(isMcp ? 'integrations.nativeMember' : 'integrations.externalMember')}>
            <select className={inputClass} required value={memberId} onChange={(event) => setMemberId(event.target.value)}>
              <option value="">{t('integrations.chooseMember')}</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.id}</option>)}
            </select>
          </Field>
        </div>
        {scopes.length > 1 && <Field label={t('integrations.approvedScope')}>
          <select className={inputClass} required value={scopeIndex} onChange={(event) => { setScopeIndex(event.target.value); setRemoteAgentId(''); setAllowedTools([]); setTools([]); setDigest('') }}>
            <option value="">{t('integrations.chooseScope')}</option>
            {scopes.map(({ target, index }) => <option key={index} value={index}>{t('integrations.scopeSummary', { index: index + 1, agents: target.remoteAgentIds.join(', '), tools: target.toolNames.join(', ') })}</option>)}
          </select>
        </Field>}
        {!members.length && <p className="text-[11px] text-ink-400">{t(isMcp ? 'integrations.noNativeMembers' : 'integrations.noExternalMembers')}</p>}
        {connection && !scopes.length && <p className="text-[12px] text-coral-deep">{t('integrations.targetUnavailable')}</p>}
        {connection && !connection.enabled && <p className="text-[11px] text-ink-400">{t('integrations.connectionDisabled')}</p>}
        {connection && !isMcp && <>
          <Field label={t('integrations.remoteAgentId')}>
            <select className={inputClass} required value={remoteAgentId} onChange={(event) => setRemoteAgentId(event.target.value)}>
              <option value="">{t('integrations.chooseRemoteAgent')}</option>
              {target?.remoteAgentIds.map((remoteId) => <option key={remoteId} value={remoteId}>{remoteId}</option>)}
            </select>
          </Field>
          <Field label={t('integrations.tenantId')}><input className={inputClass} required pattern={idPattern} maxLength={128} value={tenantId} onChange={(event) => setTenantId(event.target.value)} /></Field>
          <Field label={t(connection.backend === 'a2a' ? 'integrations.cardDigest' : 'integrations.configDigest')}><input className={`${inputClass} font-mono`} required pattern="[a-f0-9]{64}" minLength={64} maxLength={64} value={digest} onChange={(event) => setDigest(event.target.value)} /></Field>
          <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.approvalHelp')}</p>
          {connection.backend === 'a2a' ? <p className="text-[11px] text-ink-500">{t('integrations.a2aPolicy')}</p> : <>
            <fieldset className="min-w-0">
              <legend className="text-[11.5px] font-medium text-ink-500">{t('integrations.allowedTools')}</legend>
              <div className="mt-1 grid min-w-0 gap-2 sm:grid-cols-2">{knowledgeTools.filter((tool) => target?.toolNames.includes(tool)).map((tool) => <label key={tool} className="flex min-w-0 items-start gap-2 text-[12px] text-ink-700">
                <input type="checkbox" className="mt-0.5 shrink-0" checked={allowedTools.includes(tool)} onChange={(event) => setAllowedTools(event.target.checked ? [...allowedTools, tool] : allowedTools.filter((name) => name !== tool))} /><span className="break-all">{tool}</span>
              </label>)}</div>
              {!target?.toolNames.some((tool) => knowledgeTools.includes(tool)) && <p className="mt-1 text-[11px] text-coral-deep">{t('integrations.noResources')}</p>}
            </fieldset>
            <Field label={t('integrations.remoteMcpMode')}><select className={inputClass} value={mcpSelectionMode} onChange={(event) => setMcpSelectionMode(event.target.value as 'none' | 'all')}>
              <option value="none">{t('integrations.mcpNone')}</option><option value="all">{t('integrations.mcpAllEmpty')}</option>
            </select></Field>
            <p className="break-words text-[11px] text-ink-500">{t('integrations.resourceScope', { ids: connection.knowledgeBaseIds.join(', ') })}</p>
            <p className="text-[11px] leading-relaxed text-ink-500">{t('integrations.weknoraPolicy')}</p>
          </>}
        </>}
        {isMcp && <fieldset className="min-w-0 space-y-3">
          <legend className="text-[11.5px] font-medium text-ink-500">{t('integrations.mcpTools')}</legend>
          <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.schemaHelp')}</p>
          {tools.map((tool, index) => <div key={index} className={`${cardClass} space-y-2`}>
            <Field label={t('integrations.toolName')}><select className={inputClass} required value={tool.name} onChange={(event) => setTools(tools.map((item, i) => i === index ? { ...item, name: event.target.value, inputSchema: '', outputSchema: '' } : item))}>
              <option value="">{t('integrations.chooseTool')}</option>
              {target?.toolNames.map((name) => <option key={name} value={name} disabled={tools.some((item, i) => i !== index && item.name === name)}>{name}</option>)}
            </select></Field>
            <Field label={t('integrations.inputSchema')}><textarea className={`${inputClass} font-mono`} rows={5} required value={tool.inputSchema} onChange={(event) => setTools(tools.map((item, i) => i === index ? { ...item, inputSchema: event.target.value } : item))} /></Field>
            <Field label={t('integrations.outputSchema')}><textarea className={`${inputClass} font-mono`} rows={3} value={tool.outputSchema} onChange={(event) => setTools(tools.map((item, i) => i === index ? { ...item, outputSchema: event.target.value } : item))} /></Field>
            <button type="button" className={buttonClass} onClick={() => { setTools(tools.filter((_, i) => i !== index)); setReviewed(false) }}>{t('integrations.removeTool')}</button>
          </div>)}
          <button type="button" className={buttonClass} disabled={tools.length >= Math.min(32, target?.toolNames.length ?? 0)} onClick={() => { setTools([...tools, { name: '', inputSchema: '', outputSchema: '' }]); setReviewed(false) }}>{t('integrations.addTool')}</button>
        </fieldset>}
        <label className="flex items-start gap-2 text-[12px] text-ink-700"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t('integrations.enabledAfterSave')}</label>
        <label className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-700"><input type="checkbox" className="mt-0.5 shrink-0" required checked={reviewed} onChange={(event) => { event.stopPropagation(); setReviewed(event.target.checked) }} />{t(isMcp ? 'integrations.reviewTools' : 'integrations.reviewApproval')}</label>
        {error && <p role="alert" className="text-[12px] text-coral-deep">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryClass} disabled={!connection || !target || !reviewed || !memberId || (isMcp ? !tools.length : !remoteAgentId || (connection.backend === 'weknora' && !allowedTools.length))}>{t('common.save')}</button>
          <button type="button" className={buttonClass} onClick={onCancel}>{t('common.cancel')}</button>
        </div>
      </fieldset>
    </form>
  )
}

export function IntegrationSettings({ companyId }: { companyId: string }) {
  const t = useT()
  const locale = useLocale()
  const [view, setView] = useState<IntegrationManagementView | null>(null)
  const [section, setSection] = useState<View>('connections')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [busy, setBusy] = useState<string | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [probe, setProbe] = useState<{ bindingId: string; revision: number; result: IntegrationProbeResult } | null>(null)
  const [memberName, setMemberName] = useState('')
  const createRequest = useRef<{ name: string; id: string } | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  const fileInput = useRef<HTMLInputElement>(null)
  const statusArea = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error || notice) statusArea.current?.scrollIntoView({ block: 'nearest' })
  }, [error, notice])

  useEffect(() => {
    let cancelled = false
    alive.current = true
    locked.current = true
    api.getIntegrations().then((result) => { if (!cancelled) setView(result) }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof ApiError && reason.status === 403 ? 'forbidden' : 'load')
    }).finally(() => { if (!cancelled) { locked.current = false; setBusy(null) } })
    return () => { cancelled = true; alive.current = false }
  }, [])

  const run = async (action: string, operation: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setBusy(action); setError(null); setNotice(null)
    try { await operation() } catch (reason) {
      if (alive.current) setError(t(reason instanceof ApiError
        ? reason.status === 403 ? 'integrations.forbidden' : reason.status === 409 ? 'integrations.conflict' : reason.status === 400 ? 'integrations.invalidPolicy' : 'integrations.failed'
        : 'integrations.failed'))
    }
    finally { locked.current = false; if (alive.current) setBusy(null) }
  }
  const published = (result: IntegrationManagementView) => {
    if (!alive.current) return
    setView(result); setEditor(null); setProbe(null); setNotice(t('integrations.saved', { revision: result.revision }))
    void useParticipants.getState().refresh()
  }
  const save = (config: BindingConfig) => {
    if (!view) return
    void run('save', async () => published(await api.saveIntegrations(view.revision, config)))
  }
  const refresh = () => {
    if (editor && !window.confirm(t('integrations.discardConfirm'))) return
    void run('load', async () => {
      const result = await api.getIntegrations()
      if (alive.current) { setView(result); setEditor(null); setProbe(null) }
    })
  }
  const selectSection = (next: View) => {
    if (next === section) return
    if (editor && !window.confirm(t('integrations.discardConfirm'))) return
    setEditor(null); setSection(next)
  }
  const startEditor = (next: Editor) => {
    if (editor && !window.confirm(t('integrations.discardConfirm'))) return
    setError(null); setNotice(null); setEditorGeneration((generation) => generation + 1); setEditor(next)
  }
  const importFile = (file: File) => {
    if (!view) return
    void run('import', async () => {
      if (file.size > 192 * 1024) { setError(t('integrations.importInvalid')); return }
      let candidate: unknown
      try { candidate = JSON.parse(await file.text()) } catch { setError(t('integrations.importInvalid')); return }
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || !('schemaVersion' in candidate) || candidate.schemaVersion !== 1
        || !('connections' in candidate) || !Array.isArray(candidate.connections)
        || !('bindings' in candidate) || !Array.isArray(candidate.bindings)
        || Object.keys(candidate).some((key) => !['schemaVersion', 'connections', 'bindings'].includes(key))
        || candidate.connections.length > 64 || candidate.bindings.length > 128) { setError(t('integrations.importInvalid')); return }
      if (!window.confirm(t('integrations.importConfirm', { connections: candidate.connections.length, bindings: candidate.bindings.length, revision: view.revision }))) return
      published(await api.importIntegrations(view.revision, candidate as BindingConfig))
    })
  }
  const exportFile = () => void run('export', async () => {
    const config = await api.exportIntegrations()
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }))
    try {
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'integrations.json'
      document.body.append(anchor); anchor.click(); anchor.remove()
    } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0) }
    if (alive.current) setNotice(t('integrations.exported'))
  })
  const createMember = (event: FormEvent) => {
    event.preventDefault()
    const name = memberName.trim()
    if (!name) return
    if (createRequest.current?.name !== name) createRequest.current = { name, id: crypto.randomUUID() }
    const requestId = createRequest.current.id
    void run('member', async () => {
      await api.createIntegrationMember(name, requestId)
      if (alive.current) void useParticipants.getState().refresh()
      if (alive.current) { setMemberName(''); setNotice(t('integrations.memberCreated', { name })) }
      createRequest.current = null
      const result = await api.getIntegrations()
      if (alive.current) setView(result)
    })
  }
  const isBusy = busy !== null

  return (
    <section className="min-w-0 space-y-4 p-4 sm:p-5" aria-label={t('integrations.title')} aria-busy={isBusy}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink-800">{t('integrations.title')}</h3>
          <p className="mt-1 max-w-xl text-[11.5px] leading-relaxed text-ink-400">{t('integrations.help')}</p>
          {view && <p className="mt-1 text-[11px] text-ink-500">{t('integrations.revision', { revision: view.revision })}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={isBusy} onClick={refresh}>{t('integrations.refresh')}</button>
          <button type="button" className={buttonClass} disabled={isBusy || !view || !!editor} onClick={() => fileInput.current?.click()}>{t('integrations.import')}</button>
          <button type="button" className={buttonClass} disabled={isBusy || !view} onClick={exportFile}>{t('integrations.export')}</button>
          <input ref={fileInput} className="hidden" type="file" accept="application/json,.json" aria-label={t('integrations.import')} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) importFile(file) }} />
        </div>
      </div>
      <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t('integrations.views')}>
        {(['connections', 'authorizations', 'activity', 'history'] as const).map((item) => <button key={item} type="button" aria-pressed={section === item} disabled={isBusy} className={section === item ? primaryClass : buttonClass} onClick={() => selectSection(item)}>{t(`integrations.${item}`)}</button>)}
      </nav>
      <div ref={statusArea} aria-live="polite" className="scroll-mt-24 space-y-2">
        {isBusy && <p role="status" className="text-[12px] text-ink-500">{t(busy === 'load' ? 'integrations.loading' : 'integrations.working')}</p>}
        {error && <p role="alert" className="break-words rounded-[8px] bg-coral-soft/40 p-3 text-[12px] text-coral-deep">{error === 'forbidden' ? t('integrations.forbidden') : error === 'load' ? t('integrations.loadFailed') : error}</p>}
        {notice && <p role="status" className="text-[12px] text-ink-600">{notice}</p>}
      </div>
      {view && <>
        {(section === 'connections' || section === 'authorizations') && <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.publishHelp')}</p>}
        {section === 'connections' && <div className="space-y-3">
          <button type="button" className={primaryClass} disabled={isBusy || view.config.connections.length >= 64} onClick={() => startEditor({ kind: 'connection' })}>{t('integrations.addConnection')}</button>
          {!view.config.connections.length && <p className="py-3 text-[12px] text-ink-400">{t('integrations.noConnections')}</p>}
          {view.config.connections.map((connection) => <article key={connection.id} className={cardClass}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1"><h4 className="break-all text-[13px] font-semibold text-ink-800">{connection.id}</h4><p className="mt-1 text-[11px] text-ink-500">{connection.backend} · {t(connection.enabled ? 'integrations.enabled' : 'integrations.disabled')}</p></div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} disabled={isBusy} onClick={() => startEditor({ kind: 'connection', value: connection })}>{t('integrations.edit')}</button>
                <button type="button" className={buttonClass} disabled={isBusy || !!editor} onClick={() => save({ ...view.config, connections: view.config.connections.map((item) => item.id === connection.id ? { ...item, enabled: !item.enabled } : item) })}>{t(connection.enabled ? 'integrations.disable' : 'integrations.enable')}</button>
              </div>
            </div>
            <dl className="mt-2 space-y-1 text-[11px]">
              <div><dt className="text-ink-400">{t('integrations.endpoint')}</dt><dd className="break-all text-ink-700">{connection.baseUrl}</dd></div>
              <div><dt className="text-ink-400">{t('integrations.secretRef')}</dt><dd className="break-all text-ink-700">{connection.secretRef} / {connection.credentialRevision}</dd></div>
              <div><dt className="text-ink-400">{t('integrations.version')}</dt><dd className="break-all text-ink-700">{connection.version}</dd></div>
              {connection.knowledgeBaseIds.length > 0 && <div><dt className="text-ink-400">{t('integrations.knowledgeBases')}</dt><dd className="break-all text-ink-700">{connection.knowledgeBaseIds.join(', ')}</dd></div>}
            </dl>
          </article>)}
          {editor?.kind === 'connection' && <ConnectionForm key={editorGeneration} connection={editor.value} view={view} busy={isBusy} onCancel={() => setEditor(null)} onSave={(connection) => save({ ...view.config, connections: editor.value ? view.config.connections.map((item) => item.id === editor.value?.id ? connection : item) : [...view.config.connections, connection] })} />}
        </div>}
        {section === 'authorizations' && <div className="space-y-3">
          <form className={cardClass} onSubmit={createMember} aria-label={t('integrations.createMember')}>
            <h4 className="text-[13px] font-semibold text-ink-800">{t('integrations.createMember')}</h4>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{t('integrations.createMemberHelp')}</p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1"><Field label={t('integrations.memberName')}><input className={inputClass} required maxLength={80} value={memberName} disabled={isBusy} onChange={(event) => setMemberName(event.target.value)} /></Field></div>
              <button type="submit" className={primaryClass} disabled={isBusy || !!editor || !memberName.trim()}>{t('integrations.create')}</button>
            </div>
          </form>
          <button type="button" className={primaryClass} disabled={isBusy || !view.config.connections.length || view.config.bindings.length >= 128} onClick={() => startEditor({ kind: 'binding' })}>{t('integrations.addBinding')}</button>
          {!view.config.bindings.length && <p className="py-3 text-[12px] text-ink-400">{t('integrations.noBindings')}</p>}
          {view.config.bindings.map((binding) => {
            const member = view.members.find((item) => item.id === binding.subjectIds[0])
            const connection = view.config.connections.find((item) => item.id === binding.connectionId)
            return <article key={binding.id} className={cardClass}>
              <h4 className="break-all text-[13px] font-semibold text-ink-800">{binding.id}</h4>
              <p className="mt-1 break-words text-[12px] text-ink-600">{member?.name ?? binding.subjectIds[0]} · {binding.capabilityId}</p>
              <p className="mt-1 break-all text-[11px] text-ink-500">{binding.connectionId} / {binding.connectionVersion} · {t(binding.enabled && connection?.enabled ? 'integrations.enabled' : 'integrations.disabled')}</p>
              <p className="mt-1 break-all text-[11px] text-ink-500">{t('integrations.version')}: {binding.version}</p>
              {binding.kind === 'agent-service' && <p className="mt-1 break-all text-[11px] text-ink-500">{t('integrations.remoteAgentId')}: {binding.remoteAgentId}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={buttonClass} disabled={isBusy} onClick={() => startEditor({ kind: 'binding', value: binding })}>{t('integrations.edit')}</button>
                <button type="button" className={buttonClass} disabled={isBusy || !!editor} onClick={() => save({ ...view.config, bindings: view.config.bindings.map((item) => item.id === binding.id ? { ...item, enabled: !item.enabled } : item) })}>{t(binding.enabled ? 'integrations.disable' : 'integrations.enable')}</button>
                <button type="button" className={buttonClass} disabled={isBusy || !!editor || !binding.enabled || !connection?.enabled} onClick={() => { setProbe(null); void run('test', async () => { const result = await api.testIntegration(view.revision, binding.id); if (alive.current) setProbe({ bindingId: binding.id, revision: view.revision, result }) }) }}>{t('integrations.test')}</button>
              </div>
            </article>
          })}
          <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.testHelp')}</p>
          {probe && <section className={`${cardClass} space-y-2`} aria-label={t('integrations.testResult')}>
            <h4 className="break-all text-[12px] font-semibold text-ink-700">{t('integrations.testResult')} · {probe.bindingId} · {t('integrations.revision', { revision: probe.revision })}</h4>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">{(['connectivity', 'authentication', 'permission', 'business'] as const).map((stage) => <div key={stage} className="flex flex-wrap justify-between gap-2 text-[12px]">
              <dt className="text-ink-500">{t(`integrations.${stage}`)}</dt><dd className={probe.result[stage] === 'fail' ? 'text-coral-deep' : 'font-semibold text-ink-700'}>{t(`integrations.${probe.result[stage]}`)}</dd>
            </div>)}</dl>
            <p className="break-all font-mono text-[11px] text-ink-400">{probe.result.code}</p>
            <p className="text-[11px] leading-relaxed text-ink-500">{t('integrations.testHelp')}</p>
          </section>}
          {editor?.kind === 'binding' && <BindingForm key={editorGeneration} binding={editor.value} view={view} companyId={companyId} busy={isBusy} onCancel={() => setEditor(null)} onSave={(binding) => save({ ...view.config, bindings: editor.value ? view.config.bindings.map((item) => item.id === editor.value?.id ? binding : item) : [...view.config.bindings, binding] })} />}
        </div>}
        {section === 'activity' && <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.activityHelp')}</p>
          {!view.invocations.length && <p className="py-3 text-[12px] text-ink-400">{t('integrations.noActivity')}</p>}
          {view.invocations.map((item) => <article key={item.id} className={cardClass}>
            <h4 className="break-all font-mono text-[12px] text-ink-800">{item.id}</h4>
            <dl className="mt-2 grid min-w-0 grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
              <div><dt className="text-ink-400">{t('integrations.status')}</dt><dd className="break-all text-ink-700">{item.status}</dd></div>
              <div><dt className="text-ink-400">{t('integrations.createdAt')}</dt><dd className="text-ink-700">{new Date(item.createdAt).toLocaleString(locale)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-400">{t('integrations.member')}</dt><dd className="break-all text-ink-700">{view.members.find((member) => member.id === item.subjectId)?.name ?? item.subjectId}</dd></div>
              <div className="min-w-0"><dt className="text-ink-400">{t('integrations.bindingId')}</dt><dd className="break-all text-ink-700">{item.bindingId} / {item.bindingVersion}</dd></div>
              <div className="min-w-0"><dt className="text-ink-400">{t('integrations.connection')}</dt><dd className="break-all text-ink-700">{item.connectionId} / {item.connectionVersion}</dd></div>
              {item.remoteIds && Object.entries(item.remoteIds).map(([key, value]) => <div key={key} className="min-w-0"><dt className="break-all text-ink-400">{key}</dt><dd className="break-all text-ink-700">{value}</dd></div>)}
            </dl>
          </article>)}
        </div>}
        {section === 'history' && <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.historyHelp')}</p>
          {!view.history.length && <p className="py-3 text-[12px] text-ink-400">{t('integrations.noHistory')}</p>}
          {view.history.map((item) => <article key={item.revision} className={`${cardClass} flex flex-wrap items-start justify-between gap-3`}>
            <div className="min-w-0 flex-1">
              <h4 className="text-[12px] font-semibold text-ink-800">{t('integrations.revision', { revision: item.revision })}{item.revision === view.revision ? ` · ${t('integrations.current')}` : ''}</h4>
              <p className="mt-1 break-all text-[11px] text-ink-500">{t('integrations.action')}: {item.action}</p>
              <p className="mt-1 break-all text-[11px] text-ink-500">{t('integrations.actor')}: {item.actorId}</p>
              <p className="mt-1 text-[11px] text-ink-400">{new Date(item.createdAt).toLocaleString(locale)}</p>
            </div>
            <button type="button" className={buttonClass} disabled={isBusy || item.revision === view.revision} onClick={() => {
              if (window.confirm(t('integrations.rollbackConfirm', { revision: item.revision, current: view.revision }))) void run('rollback', async () => published(await api.rollbackIntegrations(view.revision, item.revision)))
            }}>{t('integrations.rollback')}</button>
          </article>)}
        </div>}
      </>}
    </section>
  )
}
