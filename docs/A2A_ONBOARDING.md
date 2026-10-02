# Connect an A2A agent

Workspace owners and admins can connect an already deployed, operator-approved A2A service from **Workspace settings → Integrations → Connect A2A agent**. No Cumora source change, paired Computer, or manually copied card digest is needed.

## Supported contract

- A2A 0.3.0 over JSON-RPC, with exactly one approved skill per endpoint.
- Bearer authentication; the Agent Card is available at `/.well-known/agent-card.json` on the same origin.
- Text input and inline text/Markdown output; one blocking `message/send`.
- The API server can reach the literal loopback URL approved by its operator. In a container or pod, loopback means **that container/pod**, not the user's laptop. Other locations need an operator-managed local forward; the wizard does not open arbitrary URLs.

Streaming, task polling/cancellation, follow-up input, and file artifacts are not supported by this first version. Advertised remote capabilities and descriptions are untrusted metadata, not proof of execution behavior.

## Minimal real example

The existing [reference report agent](../examples/reference-report-agent/index.ts) is a complete runnable example. It makes a real model call using only its explicitly supplied credentials, and records usage in a private JSONL ledger. Run the following in Bash from the repository root after installing the repository dependencies. Replace the workspace ID, model endpoint and model ID with your actual values.

```bash
mkdir -p "$HOME/.cumora/reference-report"
chmod 700 "$HOME/.cumora/reference-report"
export REFERENCE_AGENT_URL=http://127.0.0.1:5818/a2a
export REFERENCE_AGENT_TOKEN="$(openssl rand -hex 24)"
export REFERENCE_MODEL_BASE_URL=https://api.openai.com/v1
export REFERENCE_MODEL_NAME=your-model-id
read -r -s -p 'Model API key: ' REFERENCE_MODEL_API_KEY; printf '\n'
export REFERENCE_MODEL_API_KEY
export REFERENCE_USAGE_LEDGER="$HOME/.cumora/reference-report/usage.jsonl"
export CUMORA_WORKSPACE_ID=your-workspace-id
export CUMORA_INTEGRATION_TRUST_FILE="$HOME/.cumora/reference-report/trust.json"

# For a NEW trust file only; refuses to overwrite an existing file.
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs'
const e = process.env
writeFileSync(e.CUMORA_INTEGRATION_TRUST_FILE, JSON.stringify({
  schemaVersion: 1,
  grants: [{
    secretRef: 'reference-report', credentialRevision: '1',
    value: e.REFERENCE_AGENT_TOKEN, companyIds: [e.CUMORA_WORKSPACE_ID],
    backend: 'a2a', baseUrls: [e.REFERENCE_AGENT_URL],
    knowledgeBaseIds: [], remoteAgentIds: ['report'], toolNames: [],
  }],
}, null, 2), { mode: 0o600, flag: 'wx' })
NODE

node --import tsx examples/reference-report-agent/index.ts
```

The model endpoint must support the example's OpenAI-compatible Chat Completions request. Startup prints readiness and the card digest, not credentials. The example writes a report from supplied text; it does not perform retrieval or retain model conversation history.

Configure the Cumora API process with the same absolute `CUMORA_INTEGRATION_TRUST_FILE` path and restart every API instance. The file must belong to the API process user, have mode `0600`, and not be a symlink. If an existing trust file is already in use, the operator adds this grant to that file rather than replacing it. Keep credentials server-side; never import this trust file into the Web UI.

## Complete the wizard

1. Select the approved A2A service and discover its card. This performs authenticated metadata reads only; it creates no member and makes no model call.
2. Review the service, skill and text-mode limits. The card digest is computed from the complete card even though long preview text is bounded. Choose a member name and explicitly confirm permission.
3. Create and enable the member. The wizard reuses disabled-member creation and revision-checked configuration publication. The approval's tenant label is scoped to the current Cumora workspace; it is not a claim about the remote service's tenant identity. Saving does not execute a task.
4. Explicitly send a trial prompt. This is a real human message in a normal direct conversation and can consume model usage. A submitted message is not a successful test: success requires both a completed external delivery and its matching chat reply. Open the conversation to inspect the result.
5. Add that member to a group and use the mention picker to address it. The same approved service handles human DMs and exact mentions.

## If a step fails

- **No approved service:** the API operator must provision a matching workspace trust grant first. The UI cannot create credentials or approve new destinations.
- **Discovery rejected:** check the endpoint, bearer credential, protocol version, single approved skill and text modes. Metadata success does not prove that the remote server rejects unauthenticated clients.
- **Configuration changed:** refresh, discover again and review before publishing. A card change is also detected at every execution preflight; old approval does not silently accept the new card.
- **Member created but publication failed:** the member remains disabled until a successful publication. Keep its creation identity when retrying; do not repeatedly create new members.
- **Pending or unknown external work:** configuration publication can be blocked by active/unknown work. A failed or unknown trial is not retried automatically. Refresh/read the existing delivery; do not resubmit work whose remote outcome is unknown.

Discovery is `POST /api/integrations/a2a/discover` with `{ revision, target }`, where `target` is an exact entry from the current management view. Execution still uses the normal conversation/message API and the durable external-delivery pipeline.
