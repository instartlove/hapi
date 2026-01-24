import { Hono } from 'hono'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const createOrLoadSessionSchema = z.object({
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional()
})

const createOrLoadMachineSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    runnerState: z.unknown().nullable().optional()
})

const getMessagesQuerySchema = z.object({
    afterSeq: z.coerce.number().int().min(0),
    limit: z.coerce.number().int().min(1).max(200).optional()
})

const syncMessagesSchema = z.object({
    messages: z.array(z.object({
        uuid: z.string(),
        type: z.string(),
        content: z.unknown(),
        timestamp: z.union([z.string(), z.number()]).optional()
    }))
})

type CliEnv = {
    Variables: {
        namespace: string
    }
}

function resolveSessionForNamespace(
    engine: SyncEngine,
    sessionId: string,
    namespace: string
): { ok: true; session: Session } | { ok: false; status: 403 | 404; error: string } {
    const session = engine.getSessionByNamespace(sessionId, namespace)
    if (session) {
        return { ok: true, session }
    }
    if (engine.getSession(sessionId)) {
        return { ok: false, status: 403, error: 'Session access denied' }
    }
    return { ok: false, status: 404, error: 'Session not found' }
}

function resolveMachineForNamespace(
    engine: SyncEngine,
    machineId: string,
    namespace: string
): { ok: true; machine: Machine } | { ok: false; status: 403 | 404; error: string } {
    const machine = engine.getMachineByNamespace(machineId, namespace)
    if (machine) {
        return { ok: true, machine }
    }
    if (engine.getMachine(machineId)) {
        return { ok: false, status: 403, error: 'Machine access denied' }
    }
    return { ok: false, status: 404, error: 'Machine not found' }
}

export function createCliRoutes(getSyncEngine: () => SyncEngine | null): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    app.use('*', async (c, next) => {
        const raw = c.req.header('authorization')
        if (!raw) {
            return c.json({ error: 'Missing Authorization header' }, 401)
        }

        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) {
            return c.json({ error: 'Invalid Authorization header' }, 401)
        }

        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('namespace', parsedToken.namespace)
        return await next()
    })

    app.post('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadSessionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const session = engine.getOrCreateSession(parsed.data.tag, parsed.data.metadata, parsed.data.agentState ?? null, namespace)
        return c.json({ session })
    })

    app.get('/sessions/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ session: resolved.session })
    })

    app.get('/sessions/:id/messages', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const parsed = getMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const limit = parsed.data.limit ?? 200
        const messages = engine.getMessagesAfter(sessionId, { afterSeq: parsed.data.afterSeq, limit })
        return c.json({ messages })
    })

    // Sync historical messages from CLI to server
    app.post('/sessions/:id/sync-messages', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = syncMessagesSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        let synced = 0
        for (const msg of parsed.data.messages) {
            // Use uuid as localId to prevent duplicates
            engine.addMessage(sessionId, msg.content, msg.uuid)
            synced++
        }

        return c.json({ ok: true, synced })
    })

    app.post('/machines', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadMachineSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const existing = engine.getMachine(parsed.data.id)
        if (existing && existing.namespace !== namespace) {
            return c.json({ error: 'Machine access denied' }, 403)
        }
        const machine = engine.getOrCreateMachine(parsed.data.id, parsed.data.metadata, parsed.data.runnerState ?? null, namespace)
        return c.json({ machine })
    })

    app.get('/machines/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveMachineForNamespace(engine, machineId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ machine: resolved.machine })
    })

    return app
}
