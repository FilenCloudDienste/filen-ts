import type * as FileSystem from "expo-file-system"
import { AppState } from "react-native"
import { KeyedSemaphores, planSizeCapEviction } from "@filen/shared"
import { debounce } from "es-toolkit/function"
import { xxHash32 } from "js-xxhash"
import type { CacheItem } from "@/types"
import { ClearBarrier } from "@/lib/clearBarrier"
import { ensureDirectory, resetDirectory, sumLocalDirectoryFileBytes } from "@/lib/fsUtils"
import { GC_DEBOUNCE_MS } from "@/lib/cacheGc"
import logger from "@/lib/logger"

// Disk-cache key of an item: a drive item's uuid, an external item's url hash.
export function cacheItemId(item: CacheItem): string {
	return item.type === "drive" ? item.data.data.uuid : xxHash32(item.data.url).toString(16)
}

export type GcSurvivor = {
	key: string
	cachedAt: number
	size: number
}

// Soft size cap over gc survivors: the oldest go until the cache fits `maxBytes`, never the newest (the
// entry just written / in use). A single entry above the cap is kept and ages out via the TTL.
// `plannedCachedAt` lets the delete pass skip an entry a concurrent writer refreshed since planning.
export function planGcCapEviction(
	survivors: GcSurvivor[],
	maxBytes: number
): {
	evict: string[]
	plannedCachedAt: Map<string, number>
} {
	const plannedCachedAt = new Map<string, number>()

	for (const survivor of survivors) {
		plannedCachedAt.set(survivor.key, survivor.cachedAt)
	}

	return {
		evict: planSizeCapEviction(
			survivors.map(survivor => ({ id: survivor.key, size: survivor.size, timestamp: survivor.cachedAt })),
			maxBytes,
			{ protectNewest: true }
		),
		plannedCachedAt
	}
}

// What runGc hands back to gc(): null when the pass had any deletion candidate (even one the
// under-mutex re-check then spared), else the earliest survivor expiry (Infinity with no survivors).
// Until that instant, and absent a write into the directory, another default pass deletes nothing.
export function gcIdleUntil(hadCandidates: boolean, survivors: GcSurvivor[], ttlMs: number): number | null {
	if (hadCandidates) {
		return null
	}

	let earliest = Infinity

	for (const survivor of survivors) {
		earliest = Math.min(earliest, survivor.cachedAt + ttlMs)
	}

	return earliest
}

// Lifecycle shared by the disk caches rooted at one directory: per-key mutexes, a ClearBarrier that
// clear() uses to drain readers/writers/gc, and debounced + app-background gc.
export abstract class DiskCache {
	protected readonly keyMutexes = new KeyedSemaphores()
	protected readonly clearBarrier = new ClearBarrier()
	protected readonly directory: FileSystem.Directory
	private readonly tag: string
	// Bumped by every write path (see noteWrite). A default gc pass that deleted nothing records the
	// epoch it started at and the earliest survivor expiry; later default passes skip while both hold.
	private writeEpoch = 0
	private idleEpoch = -1
	private idleUntil = 0

	// Debounced gc after fresh writes + immediate gc on app-background: reclamation runs where growth
	// happens instead of competing with startup. Log-only on failure — gc hygiene isn't user-actionable.
	protected readonly scheduleGc = debounce(
		() => {
			this.gc().catch(err => {
				logger.warn(this.tag, "gc failed", { error: err })
			})
		},
		GC_DEBOUNCE_MS,
		{
			edges: ["trailing"]
		}
	)

	protected constructor(directory: FileSystem.Directory, tag: string) {
		this.directory = directory
		this.tag = tag

		this.ensureDirectory()

		AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				this.scheduleGc.cancel()

				this.gc().catch(err => {
					logger.warn(this.tag, "gc on background failed", { error: err })
				})
			}
		})
	}

	protected ensureDirectory(): void {
		ensureDirectory(this.directory)
	}

	// Write paths call this synchronously next to their first directory mutation AND again once the
	// write settles (success or failure), so a gc that overlapped any part of the write never leaves
	// the cache marked idle.
	protected noteWrite(): void {
		this.writeEpoch++
	}

	protected abstract runGc(age?: number): Promise<number | null>

	public async gc(age?: number): Promise<void> {
		if (!this.directory.exists) {
			return
		}

		const epoch = this.writeEpoch

		if (age === undefined && epoch === this.idleEpoch && Date.now() < this.idleUntil) {
			return
		}

		// Under the ClearBarrier so a concurrent clear() waits for this pass to drain instead of
		// deleting + recreating the directory mid-sweep.
		await this.clearBarrier.enter()

		try {
			const idleUntil = await this.runGc(age)

			if (age === undefined && idleUntil !== null) {
				this.idleEpoch = epoch
				this.idleUntil = idleUntil
			}
		} finally {
			this.clearBarrier.leave()
		}
	}

	public async clear(): Promise<void> {
		await this.clearBarrier.runExclusive(() => {
			resetDirectory(this.directory)
		})
	}

	public size(): number {
		return sumLocalDirectoryFileBytes(this.directory)
	}
}
