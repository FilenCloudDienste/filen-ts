import { queryClient } from "@/queries/client"
import { BASE_QUERY_KEY as DRIVE_ITEMS_BASE_QUERY_KEY } from "@/features/drive/queries/useDriveItems.query"
import { BASE_QUERY_KEY as PLAYLISTS_BASE_QUERY_KEY } from "@/features/audio/queries/usePlaylists.query"
import cache from "@/lib/cache"
import { type DriveItem } from "@/types"
import logger from "@/lib/logger"

// Yield to the event loop after this many seeded items so a whale account's pass
// cannot monopolize a single boot tick.
const YIELD_EVERY = 2000

type DriveWarmSeedRow = {
	path: { type?: string } | undefined
	data: DriveItem[]
	dataUpdatedAt: number
}

type PlaylistWarmSeedRow = {
	data: { files?: { item: DriveItem }[] }[]
}

/**
 * Rebuild the session-scoped uuid caches from the restored TanStack listing queries.
 *
 * The uuid-keyed caches are session-scoped (rebuilt every launch), but the restored listing
 * queries already hold every item the UI can render without a fetch. One pass over them restores
 * the socket handlers' / breadcrumb's / shared-context readers' pre-fetch coverage at boot.
 *
 * Safe to call twice (re-seeding is harmless) and never throws — a corrupt row is isolated per row
 * and the whole pass is wrapped so a failure can never break setup.
 */
export async function warmSeedDriveCaches(): Promise<void> {
	try {
		const start = performance.now()
		const driveRows: DriveWarmSeedRow[] = []
		const playlistRows: PlaylistWarmSeedRow[] = []

		for (const query of queryClient.getQueryCache().getAll()) {
			const key = query.queryKey[0]

			if (key === DRIVE_ITEMS_BASE_QUERY_KEY) {
				const data = query.state.data

				if (!Array.isArray(data)) {
					continue
				}

				const path = (query.queryKey[1] as { path?: { type?: string } } | undefined)?.path

				// A linked DriveItem unwraps to a plain directory/file shape and would be mis-filed
				// into the normal-dir cache; the linked context needs the parent link's meta, which
				// query data does not carry.
				if (path?.type === "linked") {
					continue
				}

				driveRows.push({
					path,
					data: data as DriveItem[],
					dataUpdatedAt: query.state.dataUpdatedAt
				})

				continue
			}

			if (key === PLAYLISTS_BASE_QUERY_KEY) {
				const data = query.state.data

				if (!Array.isArray(data)) {
					continue
				}

				playlistRows.push({
					data: data as PlaylistWarmSeedRow["data"]
				})
			}
		}

		// Ascending by dataUpdatedAt so the freshest listing is applied LAST and wins duplicate
		// uuids — key order alone is lexicographic, which would let a stale shared variant win.
		driveRows.sort((a, b) => a.dataUpdatedAt - b.dataUpdatedAt)

		let processed = 0
		let seeded = 0

		for (const row of driveRows) {
			// One corrupt row must not abort the pass.
			try {
				const offline = row.path?.type === "offline"
				const sharedOut = row.path?.type === "sharedOut"

				for (const item of row.data) {
					if (offline) {
						// Offline listings seed the uuid map only — parity with the offline fetch branch.
						cache.cacheDriveItemReference(item)
					} else {
						cache.cacheDriveItem(item, { sharedOut })
					}

					seeded++
					processed++

					if (processed % YIELD_EVERY === 0) {
						await new Promise<void>(resolve => {
							setImmediate(resolve)
						})
					}
				}
			} catch (err) {
				logger.warn("drive-warm-seed", "Skipped a corrupt restored drive listing", { error: err })
			}
		}

		for (const row of playlistRows) {
			try {
				for (const playlist of row.data) {
					for (const { item } of playlist.files ?? []) {
						cache.uuidToAnyDriveItem.set(item.data.uuid, item)

						seeded++
						processed++

						if (processed % YIELD_EVERY === 0) {
							await new Promise<void>(resolve => {
								setImmediate(resolve)
							})
						}
					}
				}
			} catch (err) {
				logger.warn("drive-warm-seed", "Skipped a corrupt restored playlist", { error: err })
			}
		}

		logger.debug("drive-warm-seed", "Warm-seeded uuid caches from restored listings", {
			rows: driveRows.length + playlistRows.length,
			items: seeded,
			ms: (performance.now() - start).toFixed(2)
		})
	} catch (err) {
		logger.warn("drive-warm-seed", "Warm seed pass failed", { error: err })
	}
}
