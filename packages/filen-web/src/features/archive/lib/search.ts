import { ENTRY_FLAG, ENTRY_KIND } from "@/lib/sdk/archiveListing"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { compareNames } from "@/features/archive/lib/naturalCompare"
import type { RowRef } from "@/features/archive/lib/sortedChildren"

export interface SearchOptions {
	cap?: number
	signal?: AbortSignal
	// Items scanned between yields to the event loop.
	yieldEvery?: number
}

export interface SearchResult {
	// Directories first, then by name.
	refs: Int32Array
	// More matched than `cap`.
	truncated: boolean
}

export const SEARCH_CAP = 1000

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function nextTask(): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 0)
	})
}

function compareRefs(store: EntryStore, a: RowRef, b: RowRef): number {
	if (a < 0 !== b < 0) {
		return a < 0 ? -1 : 1
	}

	return a < 0 ? compareNames(store.dirName(~a), store.dirName(~b)) || b - a : compareNames(store.name(a), store.name(b)) || a - b
}

// Merges sorted `added` into sorted `refs`; both stay at most `cap` long, so a plain merge is cheap.
function mergeRefs(store: EntryStore, refs: Int32Array, added: Int32Array): Int32Array {
	const merged = new Int32Array(refs.length + added.length)
	let i = 0
	let j = 0
	let k = 0

	while (i < refs.length && j < added.length) {
		const a = refs[i] ?? 0
		const b = added[j] ?? 0

		if (compareRefs(store, a, b) <= 0) {
			merged[k++] = a
			i++
		} else {
			merged[k++] = b
			j++
		}
	}

	merged.set(refs.subarray(i), k)
	merged.set(added.subarray(j), k + refs.length - i)

	return merged
}

export interface EntrySearch {
	// Scans what the store gained since the last call (where an aborted call stopped, if it was) and
	// resolves with every match so far; the same object as before when nothing new matched.
	advance: (signal?: AbortSignal) => Promise<SearchResult>
}

// Names below `scopeDir` (at any depth) holding `query`, case-insensitively, over a store a listing
// may still be appending to: entries only ever arrive at the end, so each call goes on from the
// directory and entry slot the last one reached. The ancestry walk runs only for a name that matched.
// Calls must not overlap.
export function createEntrySearch(
	store: EntryStore,
	scopeDir: number,
	query: string,
	options: Omit<SearchOptions, "signal"> = {}
): EntrySearch {
	const { cap = SEARCH_CAP, yieldEvery = 16384 } = options
	const pattern = new RegExp(escapeRegExp(query), "i")
	// Matches scanned but not yet merged in.
	const found: RowRef[] = []
	let result: SearchResult = { refs: new Int32Array(0), truncated: false }
	let nextDir = 1
	let nextSlot = 0
	let budget = yieldEvery

	function inScope(dir: number): boolean {
		if (scopeDir === 0) {
			return true
		}

		for (let node = dir; node >= 0; node = store.dirParent(node)) {
			if (node === scopeDir) {
				return true
			}
		}

		return false
	}

	// false once the cap is passed.
	function take(ref: RowRef): boolean {
		if (result.refs.length + found.length === cap) {
			result = { refs: result.refs, truncated: true }

			return false
		}

		found.push(ref)

		return true
	}

	// Counted inline: awaiting per item would cost a promise each.
	function due(): boolean {
		if (--budget > 0) {
			return false
		}

		budget = yieldEvery

		return true
	}

	async function scan(signal: AbortSignal | undefined): Promise<void> {
		const dirCount = store.dirCount
		const entryCount = store.entryCount

		for (; nextDir < dirCount; nextDir++) {
			if (due()) {
				await nextTask()
				signal?.throwIfAborted()
			}

			const id = nextDir

			if (pattern.test(store.dirName(id)) && inScope(store.dirParent(id)) && !take(~id)) {
				return
			}
		}

		for (; nextSlot < entryCount; nextSlot++) {
			if (due()) {
				await nextTask()
				signal?.throwIfAborted()
			}

			const slot = nextSlot
			// A directory with a path is listed as its node above.
			const isDirNode = store.kind(slot) === ENTRY_KIND.dir && (store.flags(slot) & ENTRY_FLAG.pathless) === 0

			if (!isDirNode && pattern.test(store.name(slot)) && inScope(store.parent(slot)) && !take(slot)) {
				return
			}
		}
	}

	return {
		advance: async signal => {
			signal?.throwIfAborted()

			if (!result.truncated) {
				await scan(signal)
			}

			if (found.length > 0) {
				const added = Int32Array.from(found).sort((a, b) => compareRefs(store, a, b))

				found.length = 0
				result = { refs: result.refs.length === 0 ? added : mergeRefs(store, result.refs, added), truncated: result.truncated }
			}

			return result
		}
	}
}

// One search over the entries the store holds when it begins.
export function searchEntries(store: EntryStore, scopeDir: number, query: string, options: SearchOptions = {}): Promise<SearchResult> {
	return createEntrySearch(store, scopeDir, query, options).advance(options.signal)
}
