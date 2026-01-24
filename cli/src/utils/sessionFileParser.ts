import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'

export type SessionFileMetadata = {
    sessionId: string
    flavor: string
    path: string
    summary?: string
    createdAt: number
    updatedAt: number
}

type ParsedSessionFields = {
    sessionIdCounts: Map<string, number>
    minTimestampBySessionId: Map<string, number>
    lastSeenSessionId: string | null
    cwd: string | null
    summary: string | null
}

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

function extractSessionIdFromFilename(filePath: string): string | null {
    const fileName = basename(filePath)
    if (!fileName.endsWith('.jsonl')) {
        return null
    }
    const base = fileName.slice(0, -'.jsonl'.length)
    const matches = base.match(new RegExp(UUID_REGEX.source, 'ig'))
    if (!matches || matches.length === 0) {
        return null
    }
    return matches[matches.length - 1]
}

function parseTimestampMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Heuristic: treat seconds as unix seconds, ms as unix ms.
        return value < 1_000_000_000_000 ? value * 1000 : value
    }
    if (typeof value === 'string') {
        const ms = Date.parse(value)
        if (Number.isFinite(ms)) {
            return ms
        }
    }
    return null
}

function trackSessionId(
    parsed: ParsedSessionFields,
    sessionId: string,
    timestampMs: number | null
): void {
    parsed.lastSeenSessionId = sessionId
    parsed.sessionIdCounts.set(sessionId, (parsed.sessionIdCounts.get(sessionId) ?? 0) + 1)
    if (timestampMs === null) {
        return
    }
    const currentMin = parsed.minTimestampBySessionId.get(sessionId)
    if (currentMin === undefined || timestampMs < currentMin) {
        parsed.minTimestampBySessionId.set(sessionId, timestampMs)
    }
}

function resolveSessionIdFromParsed(
    parsed: ParsedSessionFields,
    sessionIdFromFilename: string | null
): string | null {
    if (sessionIdFromFilename) {
        return sessionIdFromFilename
    }
    if (parsed.sessionIdCounts.size === 0) {
        return null
    }

    let bestId: string | null = null
    let bestCount = -Infinity
    for (const [id, count] of parsed.sessionIdCounts.entries()) {
        if (count > bestCount) {
            bestId = id
            bestCount = count
        } else if (count === bestCount && parsed.lastSeenSessionId === id) {
            bestId = id
        }
    }

    return bestId
}

function parseSessionFileContents(contents: string, options?: { maxLines?: number }): ParsedSessionFields {
    const maxLines = options?.maxLines ?? 500
    const lines = contents.split('\n')
    const parsed: ParsedSessionFields = {
        sessionIdCounts: new Map(),
        minTimestampBySessionId: new Map(),
        lastSeenSessionId: null,
        cwd: null,
        summary: null
    }

    for (let index = 0; index < lines.length && index < maxLines; index += 1) {
        const line = lines[index].trim()
        if (line.length === 0) {
            continue
        }
        let value: unknown
        try {
            value = JSON.parse(line)
        } catch {
            continue
        }
        if (!value || typeof value !== 'object') {
            continue
        }
        const obj = value as Record<string, unknown>

        if (parsed.summary === null && obj.type === 'summary' && typeof obj.summary === 'string') {
            parsed.summary = obj.summary
        }

        if (parsed.cwd === null && typeof obj.cwd === 'string' && obj.cwd.trim().length > 0) {
            parsed.cwd = obj.cwd
        }

        if (typeof obj.sessionId === 'string' && obj.sessionId.trim().length > 0) {
            const timestampMs = parseTimestampMs(obj.timestamp)
            trackSessionId(parsed, obj.sessionId, timestampMs)
        }
    }

    return parsed
}

export async function parseSessionFile(filePath: string): Promise<SessionFileMetadata[]> {
    if (!filePath.endsWith('.jsonl')) {
        return []
    }

    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
        fileStat = await stat(filePath)
    } catch {
        return []
    }

    let contents: string
    try {
        contents = await readFile(filePath, 'utf-8')
    } catch {
        return []
    }

    const sessionIdFromFilename = extractSessionIdFromFilename(filePath)
    const parsed = parseSessionFileContents(contents)
    const sessionId = resolveSessionIdFromParsed(parsed, sessionIdFromFilename)
    const path = parsed.cwd

    if (!sessionId || !path) {
        return []
    }

    const createdAt = parsed.minTimestampBySessionId.get(sessionId)
        ?? (Number.isFinite(fileStat.birthtimeMs) ? fileStat.birthtimeMs : fileStat.mtimeMs)

    const metadata: SessionFileMetadata = {
        sessionId,
        flavor: 'claude',
        path,
        summary: parsed.summary ?? undefined,
        createdAt: Math.floor(createdAt),
        updatedAt: Math.floor(fileStat.mtimeMs)
    }

    return [metadata]
}

export async function scanSessionDirectory(dirPath: string): Promise<SessionFileMetadata[]> {
    let entries: Dirent[]
    try {
        entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
        return []
    }

    const results: SessionFileMetadata[] = []
    const fileNames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))

    for (const fileName of fileNames) {
        const filePath = join(dirPath, fileName)
        const parsed = await parseSessionFile(filePath)
        results.push(...parsed)
    }

    results.sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) {
            return b.updatedAt - a.updatedAt
        }
        return a.sessionId.localeCompare(b.sessionId)
    })

    return results
}

export type SessionMessage = {
    uuid: string
    type: string
    content: unknown
    timestamp?: string | number
}

/**
 * Read all messages from a session file for syncing to server
 */
export async function readSessionMessages(filePath: string): Promise<SessionMessage[]> {
    if (!filePath.endsWith('.jsonl')) {
        return []
    }

    let contents: string
    try {
        contents = await readFile(filePath, 'utf-8')
    } catch {
        return []
    }

    const messages: SessionMessage[] = []
    const lines = contents.split('\n')

    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
            const value: unknown = JSON.parse(trimmed)
            if (!value || typeof value !== 'object') continue
            const obj = value as Record<string, unknown>

            const type = typeof obj.type === 'string' ? obj.type : null
            const timestamp = typeof obj.timestamp === 'string' || typeof obj.timestamp === 'number'
                ? obj.timestamp
                : undefined

            if (type === 'user' || type === 'assistant') {
                const message = obj.message
                if (!message || typeof message !== 'object') continue

                const uuid = typeof obj.uuid === 'string' && obj.uuid.trim().length > 0
                    ? obj.uuid
                    : `line-${messages.length}`

                messages.push({
                    uuid,
                    type,
                    content: {
                        role: type === 'assistant' ? 'agent' : 'user',
                        content: {
                            type: 'output',
                            data: {
                                type: type === 'assistant' ? 'assistant' : 'user',
                                uuid: typeof obj.uuid === 'string' ? obj.uuid : uuid,
                                parentUuid: obj.parentUuid ?? null,
                                isSidechain: Boolean(obj.isSidechain),
                                message
                            }
                        }
                    },
                    timestamp
                })
                continue
            }

            if (type === 'summary') {
                const summary = typeof obj.summary === 'string' ? obj.summary : null
                if (summary === null) continue

                const uuid = typeof obj.leafUuid === 'string' && obj.leafUuid.trim().length > 0
                    ? obj.leafUuid
                    : `summary-${messages.length}`

                messages.push({
                    uuid,
                    type: 'summary',
                    content: {
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'summary',
                                summary
                            }
                        }
                    },
                    timestamp
                })
            }
        } catch {
            continue
        }
    }

    return messages
}
