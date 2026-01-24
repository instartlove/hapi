import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'

import { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState, MachineMetadata, Metadata, Session } from '@/api/types'
import { notifyRunnerSessionStarted } from '@/runner/controlClient'
import { readSettings } from '@/persistence'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { runtimePath } from '@/projectPath'
import { readWorktreeEnv } from '@/utils/worktreeEnv'
import { scanSessionDirectory, readSessionMessages, type SessionFileMetadata } from '@/utils/sessionFileParser'
import packageJson from '../../package.json'

export type SessionStartedBy = 'runner' | 'terminal'

export type SessionBootstrapOptions = {
    flavor: string
    startedBy?: SessionStartedBy
    workingDirectory?: string
    tag?: string
    agentState?: AgentState | null
    existingSessionId?: string | null
}

export type SessionBootstrapResult = {
    api: ApiClient
    session: ApiSessionClient
    sessionInfo: Session
    metadata: Metadata
    machineId: string
    startedBy: SessionStartedBy
    workingDirectory: string
}

export function buildMachineMetadata(): MachineMetadata {
    return {
        host: process.env.HAPI_HOSTNAME || os.hostname(),
        platform: os.platform(),
        happyCliVersion: packageJson.version,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: runtimePath()
    }
}

export function buildSessionMetadata(options: {
    flavor: string
    startedBy: SessionStartedBy
    workingDirectory: string
    machineId: string
    now?: number
}): Metadata {
    const happyLibDir = runtimePath()
    const worktreeInfo = readWorktreeEnv()
    const now = options.now ?? Date.now()

    return {
        path: options.workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: options.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir,
        happyToolsDir: resolve(happyLibDir, 'tools', 'unpacked'),
        startedFromRunner: options.startedBy === 'runner',
        hostPid: process.pid,
        startedBy: options.startedBy,
        lifecycleState: 'running',
        lifecycleStateSince: now,
        flavor: options.flavor,
        worktree: worktreeInfo ?? undefined
    }
}

async function getMachineIdOrExit(): Promise<string> {
    const settings = await readSettings()
    const machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on ${packageJson.bugs}`)
        process.exit(1)
    }
    logger.debug(`Using machineId: ${machineId}`)
    return machineId
}

async function reportSessionStarted(sessionId: string, metadata: Metadata): Promise<void> {
    try {
        logger.debug(`[START] Reporting session ${sessionId} to runner`)
        const result = await notifyRunnerSessionStarted(sessionId, metadata)
        if (result?.error) {
            logger.debug(`[START] Failed to report to runner (may not be running):`, result.error)
        } else {
            logger.debug(`[START] Reported session ${sessionId} to runner`)
        }
    } catch (error) {
        logger.debug('[START] Failed to report to runner (may not be running):', error)
    }
}

export async function bootstrapSession(options: SessionBootstrapOptions): Promise<SessionBootstrapResult> {
    const workingDirectory = options.workingDirectory ?? process.cwd()
    const startedBy = options.startedBy ?? 'terminal'
    const sessionTag = options.tag ?? randomUUID()
    const agentState = options.agentState === undefined ? {} : options.agentState
    const existingSessionId = options.existingSessionId ?? process.env.HAPI_SESSION_ID ?? null

    const api = await ApiClient.create()

    const machineId = await getMachineIdOrExit()
    await api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata()
    })

    const freshMetadata = buildSessionMetadata({
        flavor: options.flavor,
        startedBy,
        workingDirectory,
        machineId
    })

    if (existingSessionId) {
        const sessionInfo = await api.getSession(existingSessionId)
        const session = api.sessionSyncClient(sessionInfo)

        const existingMetadata: Metadata = sessionInfo.metadata ?? freshMetadata
        const mergedMetadata: Metadata = {
            ...existingMetadata,
            ...freshMetadata,
            worktree: freshMetadata.worktree ?? existingMetadata.worktree
        }

        session.updateMetadata(() => mergedMetadata)

        await reportSessionStarted(sessionInfo.id, mergedMetadata)

        return {
            api,
            session,
            sessionInfo,
            metadata: mergedMetadata,
            machineId,
            startedBy,
            workingDirectory
        }
    }

    const sessionInfo = await api.getOrCreateSession({
        tag: sessionTag,
        metadata: freshMetadata,
        state: agentState
    })

    const session = api.sessionSyncClient(sessionInfo)

    await reportSessionStarted(sessionInfo.id, freshMetadata)

    return {
        api,
        session,
        sessionInfo,
        metadata: freshMetadata,
        machineId,
        startedBy,
        workingDirectory
    }
}

export async function loadHistoricalSessions(options?: {
    api?: ApiClient
    machineId?: string
}): Promise<void> {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude')
    const projectsRoot = join(claudeConfigDir, 'projects')

    let projects: string[]
    try {
        const entries = await readdir(projectsRoot, { withFileTypes: true })
        projects = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(projectsRoot, entry.name))
    } catch {
        return
    }

    const machineId = options?.machineId ?? (await readSettings())?.machineId ?? null
    if (!machineId) {
        logger.debug('[HISTORICAL] Missing machineId; skipping historical session load')
        return
    }

    const api = options?.api ?? await ApiClient.create()

    const bySessionId = new Map<string, SessionFileMetadata>()
    const sessionFilePaths = new Map<string, string>()
    for (const projectPath of projects) {
        // Claude stores session files directly in project directory, not in .sessions/
        const sessions = await scanSessionDirectory(projectPath)
        for (const session of sessions) {
            const existing = bySessionId.get(session.sessionId)
            if (!existing || session.updatedAt > existing.updatedAt) {
                bySessionId.set(session.sessionId, session)
                sessionFilePaths.set(session.sessionId, join(projectPath, `${session.sessionId}.jsonl`))
            }
        }
    }

    const sessions = [...bySessionId.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    if (sessions.length === 0) {
        return
    }

    logger.debug(`[HISTORICAL] Registering ${sessions.length} historical Claude sessions`)

    for (const session of sessions) {
        try {
            const metadata: Metadata = {
                path: session.path,
                host: process.env.HAPI_HOSTNAME || os.hostname(),
                version: packageJson.version,
                machineId,
                claudeSessionId: session.sessionId,
                lifecycleState: 'suspended',
                lifecycleStateSince: session.updatedAt,
                flavor: session.flavor,
                summary: session.summary
                    ? { text: session.summary, updatedAt: session.updatedAt }
                    : undefined
            }

            const hapiSession = await api.getOrCreateSession({
                tag: `claude:${session.sessionId}`,
                metadata,
                state: null
            })

            // Sync messages to server
            const filePath = sessionFilePaths.get(session.sessionId)
            if (filePath) {
                const messages = await readSessionMessages(filePath)
                if (messages.length > 0) {
                    try {
                        const result = await api.syncMessages(hapiSession.id, messages)
                        logger.debug(`[HISTORICAL] Synced ${result.synced} messages for session ${session.sessionId}`)
                    } catch (syncError) {
                        logger.debug(`[HISTORICAL] Failed to sync messages for session ${session.sessionId}`, syncError)
                    }
                }
            }
        } catch (error) {
            logger.debug(`[HISTORICAL] Failed to register Claude session ${session.sessionId}`, error)
        }
    }
}
