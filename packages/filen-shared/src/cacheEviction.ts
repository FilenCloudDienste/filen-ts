// Pure size-cap eviction planner for disk/blob caches: given entries with a byte size and a
// recency timestamp plus a byte cap, return the ids to evict (oldest-first) until the running
// total is back within the cap. The cap is SOFT and AGGREGATE — a single entry larger than the
// cap is allowed to keep the total above it rather than being evicted on its own.
//
// `protectNewest` (default false) additionally makes the single newest entry unreachable by the
// eviction loop, for callers where it may be the resource actively in use (e.g. a file mid-preview
// or mid-download) — that entry then only ages out via the caller's own TTL sweep.
export function planSizeCapEviction(
	entries: { id: string; size: number; timestamp: number }[],
	maxBytes: number,
	options?: { protectNewest?: boolean }
): string[] {
	let total = 0

	for (const entry of entries) {
		total += entry.size
	}

	if (total <= maxBytes) {
		return []
	}

	// Oldest first; with protectNewest, the newest entry sorts last and is excluded below,
	// so it is never reached by the eviction loop.
	const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp)
	const evictable = options?.protectNewest ? sorted.slice(0, -1) : sorted
	const evict: string[] = []

	for (const entry of evictable) {
		if (total <= maxBytes) {
			break
		}

		evict.push(entry.id)

		total -= entry.size
	}

	return evict
}
