import { useEffect, useEffectEvent, useState } from "react"
import type { DesktopSyncEntries, DesktopSyncError, DesktopSyncResult } from "@filen/shared/desktop"

export const SYNC_PAGE_SIZE = 100

interface PagedState<T> {
	key: string | null
	entries: T[]
	total: number | null
	error: DesktopSyncError | null
	// The offset being read; null while idle.
	requested: number | null
	// Bumped by reload so the same offset reads again.
	generation: number
	// What `entries` were read under.
	version: string
	// A newer version read again from the start while `entries` still show; null when none is.
	pending: { version: string; entries: T[] } | null
}

function initial<T>(key: string | null, version: string): PagedState<T> {
	return { key, entries: [], total: null, error: null, requested: key === null ? null : 0, generation: 0, version, pending: null }
}

export interface PagedEntries<T> {
	entries: T[]
	total: number | null
	loading: boolean
	error: DesktopSyncError | null
	hasMore: boolean
	loadMore: () => void
	reload: () => void
	// What `entries` were read under.
	version: string
}

// One of the shell's paged lists (conflicts, ignored paths, a plan's lists), read a page at a time on demand.
// `key` names what is listed; a new key starts over, null reads nothing. A new `version` of the same list reads it
// again as far as it was loaded, showing the old entries until it lands. Pages stay in this component only.
export function usePagedEntries<T>(
	key: string | null,
	load: (offset: number, limit: number) => Promise<DesktopSyncResult<DesktopSyncEntries<T>>>,
	version = ""
): PagedEntries<T> {
	const [state, setState] = useState<PagedState<T>>(() => initial(key, version))

	// Reset in render (react.dev's "adjusting state when a prop changes"), not an effect.
	if (state.key !== key) {
		setState(initial(key, version))
	} else if (key !== null && state.version !== version && state.pending?.version !== version) {
		setState(prev => ({
			...prev,
			error: null,
			requested: 0,
			generation: prev.generation + 1,
			pending: { version, entries: [] }
		}))
	}

	const read = useEffectEvent((offset: number) => load(offset, SYNC_PAGE_SIZE))
	const { requested, generation } = state

	useEffect(() => {
		if (key === null || requested === null) {
			return
		}

		let cancelled = false

		function settle(next: (prev: PagedState<T>) => PagedState<T>): void {
			if (!cancelled) {
				setState(prev => (prev.key === key ? next(prev) : prev))
			}
		}

		read(requested).then(
			result => {
				settle(prev => {
					if (!result.ok) {
						return failed(prev, result.error)
					}

					if (prev.pending === null) {
						return {
							...prev,
							entries: requested === 0 ? result.value.entries : [...prev.entries, ...result.value.entries],
							total: result.value.total,
							error: null,
							requested: null
						}
					}

					const entries = [...prev.pending.entries, ...result.value.entries]

					if (result.value.entries.length > 0 && entries.length < Math.min(prev.entries.length, result.value.total)) {
						return { ...prev, requested: entries.length, pending: { version: prev.pending.version, entries } }
					}

					return {
						...prev,
						entries,
						total: result.value.total,
						error: null,
						requested: null,
						version: prev.pending.version,
						pending: null
					}
				})
			},
			() => {
				settle(prev => failed(prev, { code: "unknown" }))
			}
		)

		return () => {
			cancelled = true
		}
	}, [key, requested, generation])

	const total = state.total

	return {
		entries: state.entries,
		total,
		// A read of a new version shows nothing; the old entries stay until it lands.
		loading: state.requested !== null && state.pending === null,
		error: state.error,
		hasMore: total !== null && state.entries.length < total,
		loadMore: () => {
			setState(prev => (prev.requested === null ? { ...prev, requested: prev.entries.length, error: null } : prev))
		},
		reload: () => {
			setState(prev => ({ ...initial<T>(prev.key, prev.pending?.version ?? prev.version), generation: prev.generation + 1 }))
		},
		version: state.version
	}
}

// A failed read of a new version drops the old entries, so trying again starts over.
function failed<T>(prev: PagedState<T>, error: DesktopSyncError): PagedState<T> {
	return prev.pending === null
		? { ...prev, error, requested: null }
		: { ...prev, entries: [], total: null, error, requested: null, version: prev.pending.version, pending: null }
}
