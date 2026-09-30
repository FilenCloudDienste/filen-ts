import type * as FileSystem from "expo-file-system"
import { AppState } from "react-native"
import { Semaphore, planSizeCapEviction } from "@filen/shared"
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

// Lifecycle shared by the disk caches rooted at one directory: per-key mutexes, a ClearBarrier that
// clear() uses to drain readers/writers/gc, and debounced + app-background gc.
export abstract class DiskCache {
	private readonly mutexes = new Map<string, Semaphore>()
	protected readonly clearBarrier = new ClearBarrier()
	protected readonly directory: FileSystem.Directory
	private readonly tag: string

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

	protected getMutexForKey(key: string): Semaphore {
		let mutex = this.mutexes.get(key)

		if (!mutex) {
			mutex = new Semaphore(1)

			this.mutexes.set(key, mutex)
		}

		return mutex
	}

	protected abstract runGc(age?: number): Promise<void>

	public async gc(age?: number): Promise<void> {
		if (!this.directory.exists) {
			return
		}

		// Under the ClearBarrier so a concurrent clear() waits for this pass to drain instead of
		// deleting + recreating the directory mid-sweep.
		await this.clearBarrier.enter()

		try {
			await this.runGc(age)
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
