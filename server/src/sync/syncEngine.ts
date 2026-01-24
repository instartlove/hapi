/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-server is the server (Socket.IO + REST)
 * - hapi CLI connects directly to the server (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import type { DecryptedMessage, ModelMode, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import { RpcGateway, type RpcCommandResponse, type RpcPathExistsResponse, type RpcReadFileResponse, type RpcUploadFileResponse, type RpcDeleteUploadResponse, type RpcListDirectoryResponse } from './rpcGateway'
import { SessionCache } from './sessionCache'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type { RpcCommandResponse, RpcPathExistsResponse, RpcReadFileResponse, RpcUploadFileResponse, RpcDeleteUploadResponse } from './rpcGateway'

export class SyncEngine {
    private readonly store: Store
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private inactivityTimer: NodeJS.Timeout | null = null
    private readonly autoSuspendAfterMs: number
    private autoSuspendRunning = false
    private autoSuspendLastCheckedAt = 0
    private readonly autoSuspendInFlight: Set<string> = new Set()
    private readonly lastActivityAtBySessionId: Map<string, number> = new Map()

    constructor(
        store: Store,
        io: Server,
        rpcRegistry: RpcRegistry,
        sseManager: SSEManager
    ) {
        this.store = store
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
        this.machineCache = new MachineCache(store, this.eventPublisher)
        this.messageService = new MessageService(store, io, this.eventPublisher)
        this.rpcGateway = new RpcGateway(io, rpcRegistry)
        this.autoSuspendAfterMs = (() => {
            const raw = process.env.HAPI_SESSION_AUTO_SUSPEND_MS
            if (!raw) return 0
            const parsed = Number.parseInt(raw, 10)
            if (!Number.isFinite(parsed) || parsed <= 0) return 0
            return parsed
        })()
        this.reloadAll()
        this.inactivityTimer = setInterval(() => {
            this.expireInactive()
            void this.autoSuspendIdleSessions()
        }, 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    subscribe(listener: SyncEventListener): () => void {
        return this.eventPublisher.subscribe(listener)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) {
            return event.namespace
        }
        if ('sessionId' in event) {
            return this.sessionCache.getSession(event.sessionId)?.namespace
        }
        if ('machineId' in event) {
            return this.machineCache.getMachine(event.machineId)?.namespace
        }
        return undefined
    }

    getSessions(): Session[] {
        return this.sessionCache.getSessions()
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.sessionCache.getSessionsByNamespace(namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessionCache.getSession(sessionId)
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        return this.sessionCache.getSessionByNamespace(sessionId, namespace)
    }

    getActiveSessions(): Session[] {
        return this.sessionCache.getActiveSessions()
    }

    getMachines(): Machine[] {
        return this.machineCache.getMachines()
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getMachinesByNamespace(namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machineCache.getMachine(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        return this.machineCache.getMachineByNamespace(machineId, namespace)
    }

    getOnlineMachines(): Machine[] {
        return this.machineCache.getOnlineMachines()
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getOnlineMachinesByNamespace(namespace)
    }

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            hasMore: boolean
        }
    } {
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getMessagesAfter(sessionId, options)
    }

    addMessage(sessionId: string, content: unknown, localId?: string): void {
        this.store.messages.addMessage(sessionId, content, localId)
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            this.sessionCache.refreshSession(event.sessionId)
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            this.machineCache.refreshMachine(event.machineId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (event.message && typeof event.message.createdAt === 'number') {
                this.recordSessionActivity(event.sessionId, event.message.createdAt)
            }
            if (!this.sessionCache.getSession(event.sessionId)) {
                this.sessionCache.refreshSession(event.sessionId)
            }
        }

        this.eventPublisher.emit(event)
    }

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        modelMode?: ModelMode
    }): void {
        this.sessionCache.handleSessionAlive(payload)
    }

    handleSessionEnd(payload: { sid: string; time: number }): void {
        this.sessionCache.handleSessionEnd(payload)
    }

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        this.machineCache.handleMachineAlive(payload)
    }

    private expireInactive(): void {
        this.sessionCache.expireInactive()
        this.machineCache.expireInactive()
    }

    private reloadAll(): void {
        this.sessionCache.reloadAll()
        this.machineCache.reloadAll()
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Session {
        return this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace)
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Machine {
        return this.machineCache.getOrCreateMachine(id, metadata, runnerState, namespace)
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: Array<{
                id: string
                filename: string
                mimeType: string
                size: number
                path: string
                previewUrl?: string
            }>
            sentFrom?: 'telegram-bot' | 'webapp'
        }
    ): Promise<void> {
        await this.messageService.sendMessage(sessionId, payload)
        this.recordSessionActivity(sessionId, Date.now())
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]>
    ): Promise<void> {
        await this.rpcGateway.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.rpcGateway.denyPermission(sessionId, requestId, decision)
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.rpcGateway.abortSession(sessionId)
    }

    async suspendSession(
        sessionId: string,
        options?: {
            by?: string
            reason?: string
        }
    ): Promise<void> {
        const session = this.sessionCache.getSession(sessionId) ?? this.sessionCache.refreshSession(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        if (!session.active) {
            const now = Date.now()
            const currentMetadata = session.metadata ?? { path: '', host: '' }
            const nextMetadata = {
                ...currentMetadata,
                lifecycleState: 'suspended',
                lifecycleStateSince: now,
                archivedBy: options?.by ?? 'webapp',
                archiveReason: options?.reason ?? 'Session suspended'
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                nextMetadata,
                session.metadataVersion,
                session.namespace
            )

            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }

            if (result.result === 'version-mismatch') {
                const refreshed = this.sessionCache.refreshSession(sessionId)
                if (!refreshed) {
                    throw new Error('Session not found')
                }

                const latestMetadata = refreshed.metadata ?? { path: '', host: '' }
                const retryMetadata = {
                    ...latestMetadata,
                    lifecycleState: 'suspended',
                    lifecycleStateSince: now,
                    archivedBy: options?.by ?? 'webapp',
                    archiveReason: options?.reason ?? 'Session suspended'
                }

                const retry = this.store.sessions.updateSessionMetadata(
                    sessionId,
                    retryMetadata,
                    refreshed.metadataVersion,
                    refreshed.namespace
                )

                if (retry.result === 'success') {
                    this.sessionCache.refreshSession(sessionId)
                    return
                }
            }

            throw new Error('Failed to suspend inactive session')
        }

        await this.rpcGateway.suspendSession(sessionId, options)
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.rpcGateway.killSession(sessionId)
        this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }

    async resumeSession(sessionId: string): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        const session = this.sessionCache.getSession(sessionId) ?? this.sessionCache.refreshSession(sessionId)
        if (!session) {
            return { type: 'error', message: 'Session not found' }
        }

        const metadata = session.metadata
        if (!metadata) {
            return { type: 'error', message: 'Missing session metadata' }
        }

        const machineId = metadata.machineId
        if (!machineId) {
            return { type: 'error', message: 'Missing machineId for session' }
        }

        const directory = metadata.worktree?.worktreePath ?? metadata.path
        if (!directory) {
            return { type: 'error', message: 'Missing session directory' }
        }

        const flavor = metadata.flavor ?? 'claude'
        const agent = flavor === 'claude' || flavor === 'codex' || flavor === 'gemini' ? flavor : 'claude'

        return await this.rpcGateway.spawnSession(
            machineId,
            directory,
            agent,
            undefined,
            'simple',
            undefined,
            sessionId
        )
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.rpcGateway.switchSession(sessionId, to)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.sessionCache.deleteSession(sessionId)
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            modelMode?: ModelMode
        }
    ): Promise<void> {
        const result = await this.rpcGateway.requestSessionConfig(sessionId, config)
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as { applied?: { permissionMode?: Session['permissionMode']; modelMode?: Session['modelMode'] } }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error('Missing applied session config')
        }

        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'codex' | 'gemini' = 'claude',
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        return await this.rpcGateway.spawnSession(machineId, directory, agent, yolo, sessionType, worktreeName)
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.rpcGateway.checkPathsExist(machineId, paths)
    }

    async listDirectory(machineId: string, path: string, showHidden?: boolean): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listDirectory(machineId, path, showHidden)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitStatus(sessionId, cwd)
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffNumstat(sessionId, options)
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffFile(sessionId, options)
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.rpcGateway.readSessionFile(sessionId, path)
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.rpcGateway.uploadFile(sessionId, filename, content, mimeType)
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.rpcGateway.deleteUploadFile(sessionId, path)
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.runRipgrep(sessionId, args, cwd)
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<{
        success: boolean
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>
        error?: string
    }> {
        return await this.rpcGateway.listSlashCommands(sessionId, agent)
    }

    private recordSessionActivity(sessionId: string, createdAt: number): void {
        if (!Number.isFinite(createdAt)) {
            return
        }
        const next = createdAt < 1_000_000_000_000 ? createdAt * 1000 : createdAt
        if (!Number.isFinite(next)) {
            return
        }
        const prev = this.lastActivityAtBySessionId.get(sessionId) ?? 0
        if (next > prev) {
            this.lastActivityAtBySessionId.set(sessionId, next)
        }
    }

    private getLastActivityAt(sessionId: string): number {
        const cached = this.lastActivityAtBySessionId.get(sessionId)
        if (cached) {
            return cached
        }

        const latest = this.store.messages.getMessages(sessionId, 1)
        const lastFromStore = latest[0]?.createdAt
        if (typeof lastFromStore === 'number') {
            this.recordSessionActivity(sessionId, lastFromStore)
            return this.lastActivityAtBySessionId.get(sessionId) ?? lastFromStore
        }

        const session = this.sessionCache.getSession(sessionId)
        const fallback = session ? session.createdAt : Date.now()
        this.lastActivityAtBySessionId.set(sessionId, fallback)
        return fallback
    }

    private async autoSuspendIdleSessions(): Promise<void> {
        if (this.autoSuspendAfterMs <= 0) {
            return
        }

        const now = Date.now()
        const minCheckIntervalMs = 10_000
        if (now - this.autoSuspendLastCheckedAt < minCheckIntervalMs) {
            return
        }
        if (this.autoSuspendRunning) {
            return
        }

        this.autoSuspendRunning = true
        this.autoSuspendLastCheckedAt = now

        try {
            for (const session of this.sessionCache.getSessions()) {
                if (!session.active) continue
                if (session.thinking) continue

                const pendingRequests = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0
                if (pendingRequests > 0) continue

                if (session.agentState?.controlledByUser === true) continue

                const lifecycleState = session.metadata?.lifecycleState
                if (typeof lifecycleState === 'string' && lifecycleState !== 'running') {
                    continue
                }

                if (this.autoSuspendInFlight.has(session.id)) {
                    continue
                }

                const lastActivityAt = this.getLastActivityAt(session.id)
                if (now - lastActivityAt < this.autoSuspendAfterMs) {
                    continue
                }

                this.autoSuspendInFlight.add(session.id)
                void this.suspendSession(session.id, { by: 'auto', reason: 'Inactive' })
                    .catch(() => { })
                    .finally(() => {
                        this.autoSuspendInFlight.delete(session.id)
                    })
            }
        } finally {
            this.autoSuspendRunning = false
        }
    }
}
