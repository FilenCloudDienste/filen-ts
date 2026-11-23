import * as Comlink from "comlink"
import { sdkApi } from "@/lib/sdk/client"
import { settleGuard } from "@/lib/workers/settleGuard"
import { buildSearchResults, type SearchResults } from "@/features/drive/hooks/useDriveSearch.logic"
import { GRACE_MS } from "@/features/drive/lib/searchStatus.logic"
import type { SearchQueryProgress } from "@/workers/searchEngine"

export type DriveSearchOnceResult = SearchResults & { total: bigint; settled: boolean; name: string }

export type DriveSearchProgress = SearchQueryProgress

// A whole-drive name search for a caller that is not the search box (the assistant), on an engine handle
// of its own beside the user's search, kept registered for `keepMs` after the last (searchEngine.ts's query), so neither disturbs the other. `names`
// are tried in order while one matches more than the engine's window holds; the hits are the fewest
// any of them had, projected into DriveItems the way the search box does. `signal` stops the query in
// the worker, which then answers with what it had.
let nextQueryId = 1

export async function searchDriveOnce(
	names: readonly string[],
	{
		capMs,
		stallMs,
		keepMs,
		signal,
		itemType = "all",
		onProgress
	}: {
		capMs: number
		stallMs: number
		keepMs: number
		signal?: AbortSignal | undefined
		itemType?: "all" | "file" | "dir"
		onProgress?: ((progress: DriveSearchProgress) => void) | undefined
	}
): Promise<DriveSearchOnceResult> {
	signal?.throwIfAborted()

	const id = nextQueryId++
	const onAbort = () => {
		void sdkApi.searchQueryCancel(id)
	}

	// A report that arrives after the result would show this search's figures over the caller's next one.
	const progress = onProgress === undefined ? undefined : settleGuard(onProgress)

	signal?.addEventListener("abort", onAbort, { once: true })

	try {
		const result = await sdkApi.searchQuery(
			{ rootUuid: null, names, itemType },
			{ settleMs: GRACE_MS, stallMs, capMs, keepMs, id },
			progress === undefined ? undefined : Comlink.proxy(progress.callback)
		)

		return { ...buildSearchResults(result.snapshot.hits), total: result.snapshot.total, settled: result.settled, name: result.name }
	} finally {
		progress?.settle()
		signal?.removeEventListener("abort", onAbort)
	}
}
