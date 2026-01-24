import { useState, useCallback, useEffect } from 'react'
import type { ApiClient } from '@/api/client'
import type { DirectoryEntry } from '@/types/api'

export type BrowseState = {
    currentPath: string
    entries: DirectoryEntry[]
    isLoading: boolean
    error: string | null
}

export function useBrowseDirectory(
    api: ApiClient | null,
    machineId: string | null,
    initialPath?: string
) {
    const [state, setState] = useState<BrowseState>({
        currentPath: initialPath || '',
        entries: [],
        isLoading: false,
        error: null
    })

    const browse = useCallback(async (path: string) => {
        if (!api || !machineId) {
            return
        }

        setState(prev => ({ ...prev, isLoading: true, error: null }))

        try {
            const result = await api.browseDirectory(machineId, path)
            setState({
                currentPath: result.path,
                entries: result.entries,
                isLoading: false,
                error: result.error || null
            })
        } catch (error) {
            setState(prev => ({
                ...prev,
                isLoading: false,
                error: error instanceof Error ? error.message : 'Failed to browse directory'
            }))
        }
    }, [api, machineId])

    const navigateUp = useCallback(() => {
        if (!state.currentPath) return
        const parent = state.currentPath.replace(/\/[^/]+\/?$/, '') || '/'
        browse(parent)
    }, [state.currentPath, browse])

    const navigateTo = useCallback((entry: DirectoryEntry) => {
        if (entry.isDirectory) {
            browse(entry.path)
        }
    }, [browse])

    useEffect(() => {
        if (initialPath && api && machineId) {
            browse(initialPath)
        }
    }, [initialPath, api, machineId, browse])

    return {
        ...state,
        browse,
        navigateUp,
        navigateTo
    }
}
