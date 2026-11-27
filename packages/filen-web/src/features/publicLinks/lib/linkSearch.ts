import * as Comlink from "comlink"
import type { AnyLinkedDir, DirPublicLink } from "@filen/sdk-rs"
import { nameSearchKey } from "@filen/shared"
import type { DriveSortBy } from "@/features/drive/lib/sort"
import { toSearchEntries, type BrowseEntry } from "@/features/publicLinks/lib/browse.logic"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"

// The page's side of a directory link's search (the worker's is workers/linkedSearch.ts): the first non-blank query of
// a directory lists its subtree once in the worker, its download reported as it goes; every query after it, and every
// sort, reads its window of matches from there. Driven from the field's and the sort's own events, never an effect.

// The matches shown at most, as the drive's search shows (its whole-set window): more say how many there are.
export const LINK_SEARCH_WINDOW = 1_000

export type LinkSearchState =
	| { status: "idle" }
	| { status: "listing"; loaded: number; total: number | null }
	// A query under way over a held listing, after an error or before any results.
	| { status: "pending" }
	| { status: "results"; entries: BrowseEntry[]; total: number }
	| { status: "error"; error: unknown }

export const IDLE_LINK_SEARCH: LinkSearchState = { status: "idle" }

// The directory searched, and the uuids of the crumbs down to it: a listing held for one of them covers it.
export interface LinkSearchScope {
	uuid: string
	dir: AnyLinkedDir
	ancestry: readonly string[]
}

interface Opening {
	uuid: string
	promise: Promise<void>
	loaded: number
	total: number | null
}

export interface LinkSearchSession {
	search: (scope: LinkSearchScope, name: string, sort: DriveSortBy) => void
	// Back to the listing (the field cleared, a directory opened); the held listing stays for the next query.
	reset: () => void
	// The page leaves the link: the held listing goes.
	close: () => void
	// The worker holds a listing for the page by another path (a slideshow's subdirectories), which may replace this
	// session's; close frees it.
	engage: () => void
}

export function createLinkSearchSession(link: DirPublicLink, onState: (state: LinkSearchState) => void): LinkSearchSession {
	// The state last published, which a query under way replaces only where it holds no results to keep.
	let current: LinkSearchState = IDLE_LINK_SEARCH
	const publish = (state: LinkSearchState): void => {
		current = state
		onState(state)
	}
	// Moves on every query and reset: only the newest query's outcome is published.
	let seq = 0
	// The directory whose listing the worker holds, as this session last opened it.
	let opened: string | null = null
	let opening: Opening | null = null
	// The listing the newest query waits on, whose progress is shown meanwhile.
	let waitingOn: Opening | null = null
	// Whether the worker may hold a listing of this session's: a page that never searched asks nothing of it to close.
	let engaged = false

	function ensureOpen(scope: LinkSearchScope): Promise<void> {
		if (opened !== null && (opened === scope.uuid || scope.ancestry.includes(opened))) {
			waitingOn = null

			return Promise.resolve()
		}

		// A listing under way of the directory or one above it covers it once it lands.
		if (opening !== null && (opening.uuid === scope.uuid || scope.ancestry.includes(opening.uuid))) {
			waitingOn = opening
			publish({ status: "listing", loaded: opening.loaded, total: opening.total })

			return opening.promise
		}

		opened = null

		const entry: Opening = { uuid: scope.uuid, promise: Promise.resolve(), loaded: 0, total: null }
		const onProgress = (loaded: number, total: number | null): void => {
			entry.loaded = loaded
			entry.total = total

			if (opening === entry && waitingOn === entry) {
				publish({ status: "listing", loaded, total })
			}
		}

		entry.promise = sdkApi.searchLinkedOpen(scope.dir, link, Comlink.proxy(onProgress)).then(
			() => {
				if (opening === entry) {
					opening = null
					opened = entry.uuid
				}
			},
			(error: unknown) => {
				if (opening === entry) {
					opening = null
				}

				throw error
			}
		)
		opening = entry
		waitingOn = entry
		engaged = true
		publish({ status: "listing", loaded: 0, total: null })

		return entry.promise
	}

	function search(scope: LinkSearchScope, name: string, sort: DriveSortBy): void {
		const id = ++seq

		if (nameSearchKey(name).length === 0) {
			waitingOn = null
			publish(IDLE_LINK_SEARCH)

			return
		}

		// A query over results keeps them until its own land; an error or nothing yet gives way to it at once.
		if (current.status === "error" || current.status === "idle") {
			publish({ status: "pending" })
		}

		ensureOpen(scope)
			.then(() =>
				id === seq ? sdkApi.searchLinkedRange({ dirUuid: scope.uuid, link, name, sort, start: 0, end: LINK_SEARCH_WINDOW }) : null
			)
			.then(
				result => {
					if (result !== null && id === seq) {
						publish({ status: "results", entries: toSearchEntries(result.hits), total: result.total })
					}
				},
				(error: unknown) => {
					if (id === seq) {
						log.warn("publicLinks", "searching the directory link failed", error)
						publish({ status: "error", error })
					}
				}
			)
	}

	function reset(): void {
		seq++
		waitingOn = null
		publish(IDLE_LINK_SEARCH)
	}

	function close(): void {
		seq++
		waitingOn = null
		opened = null
		opening = null

		if (engaged) {
			engaged = false
			void sdkApi.searchLinkedClose()
		}
	}

	return {
		search,
		reset,
		close,
		// What this session last opened may be replaced now: the next query asks the worker again (no request where
		// its listing covers the directory), and a listing under way of this session's is no longer taken as held.
		engage: () => {
			engaged = true
			opened = null
			opening = null
		}
	}
}
