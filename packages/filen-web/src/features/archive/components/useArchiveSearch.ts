import { useEffect, useRef, useState } from "react"
import { isAbortError } from "@filen/shared"
import { log } from "@/lib/log"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingSnapshot } from "@/features/archive/lib/listingSession"
import { createEntrySearch, type SearchResult } from "@/features/archive/lib/search"
import { ARCHIVE_SEARCH_DEBOUNCE_MS } from "@/features/archive/lib/archiveBrowser.logic"

export interface ArchiveSearchResult {
	store: EntryStore
	scopeDir: number
	query: string
	refs: Int32Array
	truncated: boolean
}

export interface ArchiveSearch {
	// The latest answer for this store and directory, possibly for an earlier query while the current
	// one runs (no flicker while typing); null before the first.
	shown: ArchiveSearchResult | null
	// The answer for exactly the current query is still to come.
	pending: boolean
}

interface SearchRun {
	// Scans once the debounce is up.
	start: () => void
	// The listing appended: scans the newcomers, after the scan under way if there is one.
	refresh: () => void
	cancel: () => void
}

function searchRun(store: EntryStore, scopeDir: number, query: string, onResult: (result: ArchiveSearchResult) => void): SearchRun {
	const search = createEntrySearch(store, scopeDir, query)
	const controller = new AbortController()
	let started = false
	let running = false
	// Scans asked for, and those the last pass covered.
	let asked = 0
	let covered = 0
	let last: SearchResult | null = null

	const pump = async (): Promise<void> => {
		running = true

		try {
			while (covered < asked && !controller.signal.aborted) {
				covered = asked

				const found = await search.advance(controller.signal)

				if (found !== last) {
					last = found
					onResult({ store, scopeDir, query, refs: found.refs, truncated: found.truncated })
				}
			}
		} catch (e) {
			if (!isAbortError(e)) {
				log.error("archive", "search failed", e)
			}
		} finally {
			running = false
		}
	}

	const ask = (): void => {
		asked += 1

		if (!running) {
			void pump()
		}
	}

	return {
		start: () => {
			started = true
			ask()
		},
		refresh: () => {
			if (started) {
				ask()
			}
		},
		cancel: () => {
			controller.abort()
		}
	}
}

// The browser's search below the directory shown, debounced. A query's search lives as long as the
// query, directory and store do: while a listing streams, each notification has it scan only what
// arrived since, and a scan under way is never thrown away.
export function useArchiveSearch(snapshot: ListingSnapshot, scopeDir: number, query: string): ArchiveSearch {
	const [result, setResult] = useState<ArchiveSearchResult | null>(null)
	const run = useRef<SearchRun | null>(null)
	const trimmed = query.trim()
	const store = snapshot.store

	useEffect(() => {
		if (trimmed === "") {
			return
		}

		const current = searchRun(store, scopeDir, trimmed, setResult)
		const timer = setTimeout(current.start, ARCHIVE_SEARCH_DEBOUNCE_MS)

		run.current = current

		return () => {
			clearTimeout(timer)
			current.cancel()

			if (run.current === current) {
				run.current = null
			}
		}
	}, [store, scopeDir, trimmed])

	useEffect(() => {
		run.current?.refresh()
	}, [snapshot])

	const shown = result !== null && result.store === store && result.scopeDir === scopeDir ? result : null

	return { shown, pending: trimmed !== "" && shown?.query !== trimmed }
}
