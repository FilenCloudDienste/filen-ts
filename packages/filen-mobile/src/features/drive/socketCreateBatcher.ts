import type { DriveItem } from "@/types"
import cache from "@/lib/cache"
import copyActivity from "@/features/drive/copyActivity"
import {
	driveItemsQueryIsReadForNormalParent,
	driveItemsQueryUpsertManyForNormalParent,
	driveItemsQueryUpsertManyIntoPhotos,
	driveItemsQueryUpdateForRecents
} from "@/features/drive/queries/useDriveItems.query"
import { markDirectorySizesStale } from "@/features/drive/queries/useDirectorySize.query"
import logger from "@/lib/logger"

export const SOCKET_CREATE_FLUSH_MS = 250

type PendingCreate = {
	item: DriveItem
	// A brand-new file (not a restore) also belongs in Recents.
	recent: boolean
}

// Collects created items per parent and applies them in one write per parent per window. A copy or a
// remote bulk upload echoes one create event per item; applied one by one, each rewrote (and notified,
// and queued for persisting) the whole parent listing, Photos and Recents — O(k·n) for k creates into
// a listing of n. Pending items live at most one window; every other drive event flushes them first so
// a remove, move or trash never lands before the create it follows.
class SocketCreateBatcher {
	private pending = new Map<string, Map<string, PendingCreate>>()
	private timer: ReturnType<typeof setTimeout> | null = null

	public enqueue({ parentUuid, item, recent }: { parentUuid: string; item: DriveItem; recent: boolean }): void {
		let byUuid = this.pending.get(parentUuid)

		if (!byUuid) {
			byUuid = new Map()

			this.pending.set(parentUuid, byUuid)
		}

		// A re-delivered create replaces the queued one.
		byUuid.set(item.data.uuid, {
			item,
			recent
		})

		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null

				this.flushNow()
			}, SOCKET_CREATE_FLUSH_MS)
		}
	}

	public flushNow(): void {
		if (this.timer) {
			clearTimeout(this.timer)

			this.timer = null
		}

		if (this.pending.size === 0) {
			return
		}

		const pending = this.pending

		this.pending = new Map()

		try {
			this.apply(pending)
		} catch (e) {
			logger.error("drive-socket", "applying batched creates failed", { error: e })
		}
	}

	private apply(pending: Map<string, Map<string, PendingCreate>>): void {
		const copying = copyActivity.isActive()
		const photos: { parentUuid: string; item: DriveItem }[] = []
		const recents: DriveItem[] = []

		for (const [parentUuid, byUuid] of pending) {
			const items: DriveItem[] = []
			// While a copy runs, a file under a listing nobody has read is not kept in memory: thousands of
			// copied files would otherwise sit in the uuid caches until logout. Its first read caches it.
			const cacheFiles = !copying || driveItemsQueryIsReadForNormalParent(parentUuid)

			for (const { item, recent } of byUuid.values()) {
				items.push(item)

				if (item.type === "directory") {
					cache.cacheDriveItem(item)

					continue
				}

				if (cacheFiles) {
					cache.cacheDriveItem(item)
				}

				photos.push({
					parentUuid,
					item
				})

				if (recent) {
					recents.push(item)
				}
			}

			driveItemsQueryUpsertManyForNormalParent({
				parentUuid,
				items
			})
		}

		driveItemsQueryUpsertManyIntoPhotos(photos)

		if (recents.length > 0) {
			const uuids = new Set(recents.map(item => item.data.uuid))

			driveItemsQueryUpdateForRecents({
				updater: prev => [...prev.filter(item => !uuids.has(item.data.uuid)), ...recents]
			})
		}

		markDirectorySizesStale()
	}
}

const socketCreateBatcher = new SocketCreateBatcher()

export default socketCreateBatcher
