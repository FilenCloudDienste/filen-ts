import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { estimateVisibleSlots } from "@/features/drive/lib/gridLayout"

// Slack above the strictly-visible slot count — covers a virtualizer's own overscan mounts, a resize
// transient between two ResizeObserver frames, and view-mode toggles landing mid-flight. "Generous"
// per the design call, not tuned to a byte budget: an objectURL is a cheap browser-side handle, not
// the decoded bytes themselves.
const HEADROOM_MULTIPLIER = 3

// Floor for a viewport that hasn't reported its real size yet (module load, before the first
// ResizeObserver frame) or is genuinely tiny — never let capacity collapse low enough that ordinary
// scrolling thrashes the cache.
const MIN_CAPACITY = 24

// How many live objectURLs the thumbnail service should keep at once for a surface showing this many
// thumbnail slots. Every surface sizes through this one rule, so they cannot drift apart.
export function capacityForVisibleSlots(visibleSlots: number): number {
	return Math.max(MIN_CAPACITY, Math.ceil(visibleSlots * HEADROOM_MULTIPLIER))
}

// The drive listing's capacity for a viewport of this size and view mode — see estimateVisibleSlots for
// the base slot count.
export function computeThumbnailCapacity(viewportWidth: number, viewportHeight: number, viewMode: DriveViewMode): number {
	return capacityForVisibleSlots(estimateVisibleSlots(viewportWidth, viewportHeight, viewMode))
}

export interface ThumbnailUrlCache {
	get: (uuid: string) => string | undefined
	// get() without the recency touch, for a caller that only reads the entry and never renders it.
	peek: (uuid: string) => string | undefined
	set: (uuid: string, url: string) => void
	delete: (uuid: string) => string | undefined
	setCapacity: (capacity: number) => void
	size: () => number
	// Oldest first; live, so drain it before the next mutation.
	entries: () => Iterable<[string, string]>
	// Evicts every entry through onEvict.
	clear: () => void
}

// A least-recently-used uuid -> objectURL cache, bounded to `capacity` entries. Backed by a plain
// Map: JS Map iteration order is insertion order, and re-inserting an already-present key (delete +
// set) moves it to the tail without touching any other key's relative order — that single property is
// what makes both the touch-on-access recency tracking AND the "oldest first" eviction scan below
// correct with no separate linked-list bookkeeping.
//
// INVARIANT: a url hanging out to a caller this render pass can never be the one evicted by that same
// pass. get() always touches (re-inserts) before returning, so the entry a caller is currently holding
// is immediately the Map's most-recently-inserted key — the opposite end from where evictOverCapacity
// removes. Eviction only fires inside set(), and only for keys OTHER than the one just inserted/touched
// (a fresh set() is itself a touch). So within one synchronous render, every uuid a component reads
// via get()/set() is pinned at the tail and structurally unevictable until enough LATER distinct uuids
// push it back past capacity — which the headroom multiplier above sizes against.
export function createThumbnailUrlCache(capacity: number, onEvict: (uuid: string, url: string) => void): ThumbnailUrlCache {
	let cap = Math.max(1, capacity)
	const map = new Map<string, string>()

	function evictOverCapacity(): void {
		while (map.size > cap) {
			const oldest = map.keys().next()

			if (oldest.done === true) {
				break
			}

			const uuid = oldest.value
			const url = map.get(uuid)

			map.delete(uuid)

			if (url !== undefined) {
				onEvict(uuid, url)
			}
		}
	}

	return {
		get(uuid) {
			const url = map.get(uuid)

			if (url === undefined) {
				return undefined
			}

			map.delete(uuid)
			map.set(uuid, url)

			return url
		},
		peek(uuid) {
			return map.get(uuid)
		},
		set(uuid, url) {
			map.delete(uuid)
			map.set(uuid, url)
			evictOverCapacity()
		},
		delete(uuid) {
			const url = map.get(uuid)

			map.delete(uuid)

			return url
		},
		setCapacity(next) {
			cap = Math.max(1, next)
			evictOverCapacity()
		},
		size() {
			return map.size
		},
		entries() {
			return map.entries()
		},
		clear() {
			for (const [uuid, url] of map) {
				onEvict(uuid, url)
			}

			map.clear()
		}
	}
}
