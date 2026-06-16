// Shared, pure size-cap eviction planner for the on-disk byte caches (fileCache,
// audioCache) and the expo-image disk-cap constant.
//
// The cap is SOFT and AGGREGATE: evict the OLDEST entries (by cachedAt) first until
// the combined size is within `maxBytes`, but NEVER the newest entry — that's the
// file the user is actively previewing/downloading right now. A single entry larger
// than the cap is therefore allowed to keep the cache above it; that entry ages out
// via the normal TTL gc instead of breaking the active operation.

// 250MB — parity with Android's Glide default disk-cache cap (expo-image's iOS
// SDWebImage store is otherwise only age-bounded at 1 week, hence the buildup).
export const CACHE_MAX_SIZE_BYTES = 250 * 1024 * 1024

export function planSizeCapEviction(entries: { key: string; cachedAt: number; size: number }[], maxBytes: number): string[] {
	let total = 0

	for (const entry of entries) {
		total += entry.size
	}

	if (total <= maxBytes) {
		return []
	}

	// Oldest first; the newest entry (largest cachedAt) sorts last and is never reached
	// by the loop below, so it is always protected.
	const sorted = [...entries].sort((a, b) => a.cachedAt - b.cachedAt)
	const evict: string[] = []

	for (let i = 0; i < sorted.length - 1 && total > maxBytes; i++) {
		const entry = sorted[i]

		if (!entry) {
			continue
		}

		evict.push(entry.key)

		total -= entry.size
	}

	return evict
}
