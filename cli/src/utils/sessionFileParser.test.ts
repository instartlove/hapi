import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

import { parseSessionFile, scanSessionDirectory } from './sessionFileParser'

describe('sessionFileParser', () => {
    let dir: string

    beforeEach(async () => {
        dir = join(tmpdir(), `hapi-session-file-parser-${Date.now()}-${Math.random().toString(16).slice(2)}`)
        await mkdir(dir, { recursive: true })
    })

    afterEach(async () => {
        if (existsSync(dir)) {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('parseSessionFile: parses session metadata', async () => {
        const filePath = join(dir, 'abc.jsonl')
        const createdAtMs = Date.parse('2025-01-01T00:00:00.000Z')
        const updatedAtMs = Date.parse('2025-01-02T03:04:05.000Z')
        await writeFile(filePath, [
            JSON.stringify({ type: 'summary', summary: 'Hello world', leafUuid: 'x' }),
            JSON.stringify({
                sessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                cwd: '/tmp/project',
                type: 'user',
                uuid: 'u1',
                timestamp: '2025-01-01T00:00:00.000Z'
            })
        ].join('\n') + '\n')
        await utimes(filePath, new Date(updatedAtMs), new Date(updatedAtMs))

        const result = await parseSessionFile(filePath)
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({
            sessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
            flavor: 'claude',
            path: '/tmp/project',
            summary: 'Hello world',
            createdAt: createdAtMs,
            updatedAt: updatedAtMs
        })
    })

    it('parseSessionFile: non-jsonl files return []', async () => {
        const filePath = join(dir, 'not-jsonl.txt')
        await writeFile(filePath, 'anything\n')
        const result = await parseSessionFile(filePath)
        expect(result).toEqual([])
    })

    it('parseSessionFile: extracts sessionId from filename and uses per-session timestamps', async () => {
        const sessionIdFromFilename = '33333333-3333-4333-8333-333333333333'
        const filePath = join(dir, `resume-${sessionIdFromFilename}.jsonl`)

        await writeFile(filePath, [
            JSON.stringify({
                sessionId: '11111111-1111-4111-8111-111111111111',
                cwd: '/tmp/project',
                type: 'user',
                uuid: 'u1',
                timestamp: '2025-01-01T00:00:00.000Z'
            }),
            JSON.stringify({
                sessionId: sessionIdFromFilename,
                cwd: '/tmp/project',
                type: 'assistant',
                uuid: 'a1',
                timestamp: '2025-02-01T00:00:00.000Z'
            })
        ].join('\n') + '\n')

        const result = await parseSessionFile(filePath)
        expect(result).toHaveLength(1)
        expect(result[0].sessionId).toBe(sessionIdFromFilename)
        expect(result[0].createdAt).toBe(Date.parse('2025-02-01T00:00:00.000Z'))
    })

    it('parseSessionFile: empty file returns []', async () => {
        const filePath = join(dir, 'empty.jsonl')
        await writeFile(filePath, '')
        const result = await parseSessionFile(filePath)
        expect(result).toEqual([])
    })

    it('parseSessionFile: invalid JSON is skipped', async () => {
        const filePath = join(dir, 'invalid.jsonl')
        const createdAtMs = Date.parse('2025-01-01T00:00:00.000Z')
        await writeFile(filePath, [
            '{this is not json',
            JSON.stringify({
                sessionId: '11111111-1111-4111-8111-111111111111',
                cwd: '/tmp/project',
                type: 'user',
                uuid: 'u1',
                timestamp: '2025-01-01T00:00:00.000Z'
            })
        ].join('\n') + '\n')

        const result = await parseSessionFile(filePath)
        expect(result).toHaveLength(1)
        expect(result[0].sessionId).toBe('11111111-1111-4111-8111-111111111111')
        expect(result[0].createdAt).toBe(createdAtMs)
        expect(result[0].path).toBe('/tmp/project')
    })

    it('parseSessionFile: numeric timestamps in seconds are supported', async () => {
        const filePath = join(dir, 'numeric-timestamp.jsonl')
        await writeFile(filePath, JSON.stringify({
            sessionId: '44444444-4444-4444-8444-444444444444',
            cwd: '/tmp/project',
            type: 'user',
            uuid: 'u1',
            timestamp: 1735689600
        }) + '\n')

        const result = await parseSessionFile(filePath)
        expect(result).toHaveLength(1)
        expect(result[0].createdAt).toBe(1735689600 * 1000)
    })

    it('parseSessionFile: missing sessionId returns []', async () => {
        const filePath = join(dir, 'missing-sessionId.jsonl')
        await writeFile(filePath, [
            JSON.stringify({ type: 'summary', summary: 'No session id', leafUuid: 'x' }),
            JSON.stringify({ cwd: '/tmp/project', type: 'user', uuid: 'u1', timestamp: '2025-01-01T00:00:00.000Z' })
        ].join('\n') + '\n')

        const result = await parseSessionFile(filePath)
        expect(result).toEqual([])
    })

    it('parseSessionFile: missing cwd returns []', async () => {
        const filePath = join(dir, 'missing-cwd.jsonl')
        await writeFile(filePath, [
            JSON.stringify({
                sessionId: '22222222-2222-4222-8222-222222222222',
                type: 'user',
                uuid: 'u1',
                timestamp: '2025-01-01T00:00:00.000Z'
            })
        ].join('\n') + '\n')

        const result = await parseSessionFile(filePath)
        expect(result).toEqual([])
    })

    it('scanSessionDirectory: directory not found returns []', async () => {
        const missing = join(dir, 'does-not-exist')
        const result = await scanSessionDirectory(missing)
        expect(result).toEqual([])
    })

    it('scanSessionDirectory: scans only valid .jsonl files', async () => {
        const a = join(dir, 'a.jsonl')
        const b = join(dir, 'b.txt')
        const c = join(dir, 'c.jsonl')
        const d = join(dir, 'd.jsonl')
        await mkdir(join(dir, 'subdir'), { recursive: true })

        await writeFile(a, JSON.stringify({
            sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            cwd: '/tmp/a',
            type: 'user',
            uuid: 'u1',
            timestamp: '2025-01-01T00:00:00.000Z'
        }) + '\n')
        await writeFile(b, 'ignore me\n')
        await writeFile(c, JSON.stringify({ type: 'summary', summary: 'missing fields', leafUuid: 'x' }) + '\n')
        await writeFile(d, JSON.stringify({
            sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            cwd: '/tmp/d',
            type: 'user',
            uuid: 'u1',
            timestamp: '2025-01-03T00:00:00.000Z'
        }) + '\n')

        const older = Date.parse('2025-01-05T00:00:00.000Z')
        const newer = Date.parse('2025-01-06T00:00:00.000Z')
        await utimes(a, new Date(older), new Date(older))
        await utimes(d, new Date(newer), new Date(newer))

        const result = await scanSessionDirectory(dir)
        expect(result.map(r => r.sessionId)).toEqual([
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        ])
    })
})
