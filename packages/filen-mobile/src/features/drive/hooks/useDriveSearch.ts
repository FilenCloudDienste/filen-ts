import { useState, useEffect } from "react"
import { debounce } from "es-toolkit/function"
import { run } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import drive from "@/features/drive/drive"
import alerts from "@/lib/alerts"

export type UseDriveSearch = {
	searchQuery: string
	setSearchQuery: React.Dispatch<React.SetStateAction<string>>
	globalSearchResult: DriveItem[]
	queryingGlobalSearch: boolean
}

type DriveSearcher = {
	// The debounced global searcher. Stable identity for the lifetime of the hook.
	run: (value: string, pathType: DrivePath["type"], selectOptions: DrivePath["selectOptions"]) => void
	// Cancels a scheduled (not-yet-fired) debounce.
	cancel: () => void
	// Aborts the in-flight SDK search, if any.
	abortInflight: () => void
}

/**
 * Owns Drive's search state: the local query string plus the debounced global
 * (SDK-backed) search that augments the visible list on the `/drive` variant.
 *
 * The debounced searcher is created ONCE via a lazy `useState` initializer, so
 * its identity is STABLE across re-renders. (Previously it was rebuilt in an
 * IIFE on every render, which made the dependent effects fire every render and
 * the teardown `cancel()` unstable.) The in-flight aborter lives in a closure
 * variable captured by both the searcher and its `abortInflight` — no React ref
 * or mutable state is involved, so it satisfies both `react-hooks/refs` and the
 * React Compiler's immutable-state rules.
 *
 * `type` + `selectOptions` are forwarded as call args (the only drivePath fields
 * the search reads — it keys off `name`, never the uuid); es-toolkit's
 * trailing-edge debounce runs with the most recent args, matching the original
 * read-at-call-time behavior exactly.
 */
export function useDriveSearch({ drivePath }: { drivePath: DrivePath }): UseDriveSearch {
	const [searchQuery, setSearchQuery] = useState<string>("")
	const [globalSearchResult, setGlobalSearchResult] = useState<DriveItem[]>([])
	const [queryingGlobalSearch, setQueryingGlobalSearch] = useState<boolean>(false)

	const [searcher] = useState<DriveSearcher>(() => {
		// In-flight aborter, captured by the closures below. A plain local — not a
		// React ref/state — so mutating it is unrestricted.
		let inflight: AbortController | null = null

		const debounced = debounce(async (value: string, pathType: DrivePath["type"], selectOptions: DrivePath["selectOptions"]) => {
			// Cancel any in-flight global search before starting (or skipping) a new
			// one so a stale SDK result for a previous query/directory cannot land
			// after navigation and pollute this screen's item list.
			inflight?.abort()
			inflight = null

			if (pathType !== "drive" || selectOptions) {
				setGlobalSearchResult([])
				setQueryingGlobalSearch(false)

				return
			}

			const normalized = value.trim().toLowerCase()

			if (normalized.length === 0) {
				setGlobalSearchResult([])
				setQueryingGlobalSearch(false)

				return
			}

			// Global search hits the SDK (findItemMatchesForName) — offline this
			// would throw a network error and produce a banner storm. Clear search
			// state silently; local-filter results (which stay applied via the
			// itemsSorted derivation in Drive) still narrow the visible list.
			if (!onlineManager.isOnline()) {
				setGlobalSearchResult([])
				setQueryingGlobalSearch(false)

				return
			}

			const abortController = new AbortController()

			inflight = abortController

			setQueryingGlobalSearch(true)
			setGlobalSearchResult([])

			const result = await run(async defer => {
				defer(() => {
					setQueryingGlobalSearch(false)
				})

				return await drive.findItemMatchesForName({
					name: normalized,
					signal: abortController.signal
				})
			})

			// A newer search (or a navigation/unmount) aborted this request — drop
			// its result so it cannot overwrite the current view's state.
			if (abortController.signal.aborted) {
				return
			}

			inflight = null

			setQueryingGlobalSearch(false)

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				setGlobalSearchResult([])

				return
			}

			setGlobalSearchResult(result.data.map(({ item }) => item))
		}, 1000)

		return {
			run: debounced,
			cancel: () => debounced.cancel(),
			abortInflight: () => {
				inflight?.abort()
				inflight = null
			}
		}
	})

	useEffect(() => {
		if (drivePath.type !== "drive" || drivePath.selectOptions) {
			return
		}

		searcher.run(searchQuery, drivePath.type, drivePath.selectOptions)
	}, [searchQuery, searcher, drivePath.type, drivePath.selectOptions])

	useEffect(() => {
		return () => {
			searcher.cancel()
		}
	}, [searcher])

	// Abort any in-flight global search when the directory changes or the screen
	// unmounts so a stale SDK result cannot land on a different view.
	useEffect(() => {
		return () => {
			searcher.abortInflight()
		}
	}, [drivePath.uuid, searcher])

	return {
		searchQuery,
		setSearchQuery,
		globalSearchResult,
		queryingGlobalSearch
	}
}

export default useDriveSearch
