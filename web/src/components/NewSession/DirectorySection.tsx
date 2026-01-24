import { useState, useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { ApiClient } from '@/api/client'
import type { DirectoryEntry } from '@/types/api'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { useTranslation } from '@/lib/use-translation'

type BrowseMode = 'suggestions' | 'browse'

export function DirectorySection(props: {
    api: ApiClient | null
    machineId: string | null
    directory: string
    suggestions: readonly Suggestion[]
    selectedIndex: number
    isDisabled: boolean
    recentPaths: string[]
    onDirectoryChange: (value: string) => void
    onDirectoryFocus: () => void
    onDirectoryBlur: () => void
    onDirectoryKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
    onSuggestionSelect: (index: number) => void
    onPathClick: (path: string) => void
}) {
    const { t } = useTranslation()
    const [mode, setMode] = useState<BrowseMode>('suggestions')
    const [isOpen, setIsOpen] = useState(false)
    const [browseEntries, setBrowseEntries] = useState<DirectoryEntry[]>([])
    const [browsePath, setBrowsePath] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [browseError, setBrowseError] = useState<string | null>(null)
    const [filter, setFilter] = useState('')
    const [browseSelectedIndex, setBrowseSelectedIndex] = useState(-1)
    const containerRef = useRef<HTMLDivElement>(null)

    const browse = useCallback(async (path: string) => {
        if (!props.api || !props.machineId) return

        setIsLoading(true)
        setBrowseError(null)
        setFilter('')
        setBrowseSelectedIndex(-1)

        try {
            const result = await props.api.browseDirectory(props.machineId, path)
            setBrowsePath(result.path)
            setBrowseEntries(result.entries)
            if (result.error) {
                setBrowseError(result.error)
            }
        } catch (error) {
            setBrowseError(error instanceof Error ? error.message : 'Failed to browse')
        } finally {
            setIsLoading(false)
        }
    }, [props.api, props.machineId])

    const handleInputFocus = useCallback(() => {
        props.onDirectoryFocus()
        if (mode === 'suggestions') {
            setIsOpen(true)
        }
    }, [props.onDirectoryFocus, mode])

    const handleInputBlur = useCallback(() => {
        props.onDirectoryBlur()
        setTimeout(() => {
            if (!containerRef.current?.contains(document.activeElement)) {
                setIsOpen(false)
                setMode('suggestions')
            }
        }, 150)
    }, [props.onDirectoryBlur])

    const handleBrowseClick = useCallback(() => {
        setMode('browse')
        setIsOpen(true)
        const startPath = props.directory.trim() || '/home'
        browse(startPath)
    }, [props.directory, browse])

    const handleEntryClick = useCallback((entry: DirectoryEntry) => {
        if (entry.isDirectory) {
            browse(entry.path)
        } else {
            props.onDirectoryChange(entry.path)
            setIsOpen(false)
            setMode('suggestions')
        }
    }, [browse, props.onDirectoryChange])

    const handleSelectCurrent = useCallback(() => {
        if (browsePath) {
            props.onDirectoryChange(browsePath)
            setIsOpen(false)
            setMode('suggestions')
        }
    }, [browsePath, props.onDirectoryChange])

    const handleNavigateUp = useCallback(() => {
        if (!browsePath || browsePath === '/') return
        const parent = browsePath.replace(/\/[^/]+\/?$/, '') || '/'
        browse(parent)
    }, [browsePath, browse])

    const filteredEntries = browseEntries.filter(entry =>
        entry.name.toLowerCase().includes(filter.toLowerCase())
    )

    const handleBrowseKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (mode !== 'browse') return

        if (event.key === 'ArrowUp') {
            event.preventDefault()
            setBrowseSelectedIndex(prev => Math.max(-1, prev - 1))
        } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setBrowseSelectedIndex(prev => Math.min(filteredEntries.length - 1, prev + 1))
        } else if (event.key === 'Enter') {
            event.preventDefault()
            if (browseSelectedIndex >= 0 && filteredEntries[browseSelectedIndex]) {
                handleEntryClick(filteredEntries[browseSelectedIndex])
            } else if (filter && filteredEntries.length > 0) {
                handleEntryClick(filteredEntries[0])
            }
        } else if (event.key === 'Escape') {
            setIsOpen(false)
            setMode('suggestions')
        } else if (event.key === 'Backspace' && filter === '') {
            event.preventDefault()
            handleNavigateUp()
        }
    }, [mode, browseSelectedIndex, filteredEntries, handleNavigateUp, handleEntryClick, filter])

    useEffect(() => {
        setBrowseSelectedIndex(-1)
    }, [filter])

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3" ref={containerRef}>
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.directory')}
            </label>
            <div className="relative">
                <div className="flex gap-2">
                    <input
                        type="text"
                        placeholder={t('newSession.placeholder')}
                        value={props.directory}
                        onChange={(event) => props.onDirectoryChange(event.target.value)}
                        onKeyDown={props.onDirectoryKeyDown}
                        onFocus={handleInputFocus}
                        onBlur={handleInputBlur}
                        disabled={props.isDisabled}
                        className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    />
                    <button
                        type="button"
                        onClick={handleBrowseClick}
                        disabled={props.isDisabled || !props.machineId}
                        className="px-3 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-sm hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 transition-colors"
                        title="Browse directories"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                    </button>
                </div>

                {isOpen && mode === 'suggestions' && props.suggestions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 z-10 mt-1">
                        <FloatingOverlay maxHeight={200}>
                            <Autocomplete
                                suggestions={props.suggestions}
                                selectedIndex={props.selectedIndex}
                                onSelect={props.onSuggestionSelect}
                            />
                        </FloatingOverlay>
                    </div>
                )}

                {isOpen && mode === 'browse' && (
                    <div className="absolute top-full left-0 right-0 z-10 mt-1">
                        <FloatingOverlay maxHeight={300}>
                            <div className="bg-[var(--app-secondary-bg)] rounded-lg border border-[var(--app-border)] overflow-hidden">
                                <div className="p-2 border-b border-[var(--app-border)] flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={handleNavigateUp}
                                        disabled={!browsePath || browsePath === '/'}
                                        className="p-1 rounded hover:bg-[var(--app-subtle-bg)] disabled:opacity-30"
                                        title="Go up"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                        </svg>
                                    </button>
                                    <span className="text-xs text-[var(--app-hint)] truncate flex-1" title={browsePath}>
                                        {browsePath}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={handleSelectCurrent}
                                        className="px-2 py-1 text-xs bg-[var(--app-link)] text-[var(--app-bg)] rounded hover:opacity-90"
                                    >
                                        {t('newSession.select')}
                                    </button>
                                </div>

                                <div className="p-2 border-b border-[var(--app-border)]">
                                    <input
                                        type="text"
                                        placeholder={t('newSession.browse.filter')}
                                        value={filter}
                                        onChange={(e) => setFilter(e.target.value)}
                                        onKeyDown={handleBrowseKeyDown}
                                        autoFocus
                                        className="w-full px-2 py-1 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                                    />
                                </div>

                                <div className="max-h-[200px] overflow-y-auto">
                                    {isLoading ? (
                                        <div className="p-3 text-center text-sm text-[var(--app-hint)]">
                                            {t('newSession.browse.loading')}
                                        </div>
                                    ) : browseError ? (
                                        <div className="p-3 text-center text-sm text-red-500">
                                            {browseError}
                                        </div>
                                    ) : filteredEntries.length === 0 ? (
                                        <div className="p-3 text-center text-sm text-[var(--app-hint)]">
                                            {filter ? t('newSession.browse.noMatch') : t('newSession.browse.empty')}
                                        </div>
                                    ) : (
                                        <div className="py-1">
                                            {!filter && browsePath && browsePath !== '/' && (
                                                <button
                                                    type="button"
                                                    onClick={handleNavigateUp}
                                                    className="w-full px-3 py-2 flex items-center gap-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] transition-colors"
                                                    style={{ minHeight: '44px' }}
                                                >
                                                    <svg className="w-4 h-4 text-[var(--app-hint)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                                    </svg>
                                                    <span className="text-[var(--app-hint)]">..</span>
                                                </button>
                                            )}
                                            {filteredEntries.map((entry, index) => (
                                                <button
                                                    key={entry.path}
                                                    type="button"
                                                    onClick={() => handleEntryClick(entry)}
                                                    className={`w-full px-3 py-2 flex items-center gap-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] transition-colors ${
                                                        index === browseSelectedIndex ? 'bg-[var(--app-subtle-bg)]' : ''
                                                    }`}
                                                    style={{ minHeight: '44px' }}
                                                >
                                                    {entry.isDirectory ? (
                                                        <svg className="w-4 h-4 text-[var(--app-link)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                                        </svg>
                                                    ) : (
                                                        <svg className="w-4 h-4 text-[var(--app-hint)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                        </svg>
                                                    )}
                                                    <span className="truncate">{entry.name}</span>
                                                    {entry.isDirectory && (
                                                        <svg className="w-4 h-4 text-[var(--app-hint)] ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                        </svg>
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </FloatingOverlay>
                    </div>
                )}
            </div>

            {props.recentPaths.length > 0 && (
                <div className="flex flex-col gap-1 mt-1">
                    <span className="text-xs text-[var(--app-hint)]">{t('newSession.recent')}:</span>
                    <div className="flex flex-wrap gap-1">
                        {props.recentPaths.map((path) => (
                            <button
                                key={path}
                                type="button"
                                onClick={() => props.onPathClick(path)}
                                disabled={props.isDisabled}
                                className="rounded bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors truncate max-w-[200px] disabled:opacity-50"
                                title={path}
                            >
                                {path}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
