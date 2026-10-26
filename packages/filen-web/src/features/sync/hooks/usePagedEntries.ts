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
}

function initial<T>(key: string | null): PagedState<T> {
	return { key, entries: [], total: null, error: null, requested: key === null ? null : 0, generation: 0 }
}

export interface PagedEntries<T> {
	entries: T[]
	total: number | null
	loading: boolean
	error: DesktopSyncError | null
	hasMore: boolean
	loadMore: () => void
	reload: () => void
}

// One of the shell's paged lists (conflicts, ignored paths, a plan's lists), read a page at a time on demand.
// `key` names what is listed; a new key starts over, null reads nothing. Pages stay in this component only.
export function usePagedEntries<T>(
	key: string | null,
	load: (offset: number, limit: number) => Promise<DesktopSyncResult<DesktopSyncEntries<T>>>
): PagedEntries<T> {
	const [state, setState] = useState<PagedState<T>>(() => initial(key))

	// Reset in render (react.dev's "adjusting state when a prop changes"), not an effect.
	if (state.key !== key) {
		setState(initial(key))
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
				settle(prev =>
					result.ok
						? {
								...prev,
								entries: requested === 0 ? result.value.entries : [...prev.entries, ...result.value.entries],
								total: result.value.total,
								error: null,
								requested: null
							}
						: { ...prev, error: result.error, requested: null }
				)
			},
			() => {
				settle(prev => ({ ...prev, error: { code: "unknown" }, requested: null }))
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
		loading: state.requested !== null,
		error: state.error,
		hasMore: total !== null && state.entries.length < total,
		loadMore: () => {
			setState(prev => (prev.requested === null ? { ...prev, requested: prev.entries.length, error: null } : prev))
		},
		reload: () => {
			setState(prev => ({ ...initial<T>(prev.key), generation: prev.generation + 1 }))
		}
	}
}
