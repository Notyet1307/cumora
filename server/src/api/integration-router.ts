import { Router, type Request, type Response, type NextFunction } from 'express'
import type { AuthedRequest } from '../auth.js'
import { HttpError } from '../admin.js'
import { getIntegrationManagement } from '../integrations/management.js'
import type { BindingConfig } from '../integrations/bindings.js'

function body(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new HttpError(400, 'integration_invalid_request')
  }
  return value as Record<string, unknown>
}

/** Active company resolution uses the parent's authenticated tenancy boundary;
 * management repeats live owner/admin authorization inside every transaction. */
export function createIntegrationRouter(deps: {
  requireCompany: (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>
}): Router {
  const router = Router()
  router.get('/', async (req, res) => {
    const actor = await deps.requireCompany(req)
    res.json(await getIntegrationManagement().view(actor.companyId, actor.userId))
  })
  router.put('/', async (req, res) => {
    const actor = await deps.requireCompany(req)
    const input = body(req.body, ['expectedRevision', 'config'])
    res.json(await getIntegrationManagement().save(actor.companyId, actor.userId, input.expectedRevision as number, input.config as BindingConfig))
  })
  router.post('/import', async (req, res) => {
    const actor = await deps.requireCompany(req)
    const input = body(req.body, ['expectedRevision', 'config'])
    res.json(await getIntegrationManagement().save(actor.companyId, actor.userId, input.expectedRevision as number, input.config as BindingConfig, 'import'))
  })
  router.post('/rollback', async (req, res) => {
    const actor = await deps.requireCompany(req)
    const input = body(req.body, ['expectedRevision', 'revision'])
    res.json(await getIntegrationManagement().rollback(actor.companyId, actor.userId, input.expectedRevision as number, input.revision as number))
  })
  router.post('/members', async (req, res) => {
    const actor = await deps.requireCompany(req)
    const input = body(req.body, ['name', 'requestId'])
    res.json(await getIntegrationManagement().createMember(actor.companyId, actor.userId, input.name as string, input.requestId as string))
  })
  router.post('/test', async (req, res) => {
    const actor = await deps.requireCompany(req)
    const input = body(req.body, ['revision', 'bindingId'])
    res.json(await getIntegrationManagement().test(actor.companyId, actor.userId, input.revision as number, input.bindingId as string))
  })
  router.get('/export', async (req, res) => {
    const actor = await deps.requireCompany(req)
    const view = await getIntegrationManagement().view(actor.companyId, actor.userId)
    res.setHeader('Content-Disposition', 'attachment; filename="integrations.json"')
    res.json(view.config)
  })
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Do not log exception bodies: driver/DB errors can include request values.
    if (error instanceof HttpError) res.status(error.status).json({ error: error.message })
    else if (error && typeof error === 'object' && 'status' in error && (error.status === 401 || error.status === 403 || error.status === 404)) {
      res.status(403).json({ error: 'integration_forbidden' })
    } else res.status(500).json({ error: 'integration_unavailable' })
  })
  return router
}
