import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { newTmpFile } from "@/lib/tmp"
import {
	AnyDirWithContext,
	AnyNormalDir,
	AnySharedDir,
	AnySharedDirWithContext,
	AnyDirWithContext_Tags,
	AnySharedDir_Tags,
	AnyNormalDir_Tags,
	AnyLinkedDir_Tags
} from "@filen/sdk-rs"
import { type DriveItem } from "@/types"
import cache from "@/lib/cache"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import { isDirectoryItem } from "@/features/drive/driveSelectors"

// "sharedInRoot" means the item lives at the top level of Shared In (no parent dir, just the shared root listing).
export type OfflineParent = AnyDirWithContext | "sharedInRoot"

/**
 * Write data to a file atomically using write-to-temp-then-move.
 * Prevents corruption from crashes mid-write: the destination is replaced by a SINGLE
 * overwriting move (expo-file-system v56 `moveSync` honors RelocationOptions `overwrite`
 * natively on both platforms) — never a delete-then-move pair, which had a window where
 * a crash between the two steps left the destination missing entirely.
 */
export function atomicWrite(file: FileSystem.File, data: string | Uint8Array): FileSystem.File {
	const tmp = newTmpFile(`.tmp-${randomUUID()}`)

	tmp.write(data)

	try {
		tmp.moveSync(file, {
			overwrite: true
		})

		return file
	} catch (e) {
		if (tmp.exists) {
			tmp.delete()
		}

		throw e
	}
}

// Produces a stable string key from the deeply-nested AnyDirWithContext tagged union.
// Used to dedup parent listings in sync() and for the listDirectories cache.
export function parentCacheKey(parent: OfflineParent): string {
	if (typeof parent === "string") {
		return parent
	}

	switch (parent.tag) {
		case AnyDirWithContext_Tags.Normal: {
			switch (parent.inner[0].tag) {
				case AnyNormalDir_Tags.Dir: {
					return `dir:${parent.inner[0].inner[0].uuid}`
				}

				case AnyNormalDir_Tags.Root: {
					return `root:${parent.inner[0].inner[0].uuid}`
				}

				default: {
					throw new Error("Unknown AnyNormalDir tag")
				}
			}
		}

		case AnyDirWithContext_Tags.Shared: {
			switch (parent.inner[0].dir.tag) {
				case AnySharedDir_Tags.Dir: {
					return `shared-dir:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				case AnySharedDir_Tags.Root: {
					return `shared-root:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				default: {
					throw new Error("Unknown AnySharedDir tag")
				}
			}
		}

		case AnyDirWithContext_Tags.Linked: {
			switch (parent.inner[0].dir.tag) {
				case AnyLinkedDir_Tags.Dir: {
					return `linked-dir:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				case AnyLinkedDir_Tags.Root: {
					return `linked-root:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				default: {
					throw new Error("Unknown AnyLinkedDir tag")
				}
			}
		}

		default: {
			throw new Error("Unknown AnyDirWithContext tag")
		}
	}
}

export type OfflineSyncErrorKind = "download" | "listing" | "verify" | "store"

export type OfflineSyncError = {
	// `${itemUuid}:${kind}` — stable for dedup
	id: string
	itemUuid: string
	topLevelUuid: string | null
	name: string
	itemType: DriveItem["type"]
	kind: OfflineSyncErrorKind
	message: string
	// A degraded-listing marker (scan errors / undecodable listed metas): the reconcile pass
	// skipped its delete phase but is otherwise trustworthy, so a pass whose errors are ALL
	// degraded still commits (verified-union meta). Verify/download failures are never degraded.
	degraded?: boolean
	timestamp: number
}

// Single OfflineSyncError constructor shared by the storage layer (offline.ts reconcileTree) and
// the sync orchestrator (offlineSync.ts) so the id/dedup shape can never drift between the two.
export function makeSyncError({
	itemUuid,
	topLevelUuid,
	name,
	itemType,
	kind,
	message,
	degraded
}: {
	itemUuid: string
	topLevelUuid: string | null
	name: string
	itemType: DriveItem["type"]
	kind: OfflineSyncErrorKind
	message: string
	degraded?: boolean
}): OfflineSyncError {
	return {
		id: `${itemUuid}:${kind}`,
		itemUuid,
		topLevelUuid,
		name,
		itemType,
		kind,
		message,
		degraded,
		timestamp: Date.now()
	}
}

// Converts a directory DriveItem directly into an AnyDirWithContext (or OfflineParent) for SDK calls.
// Returns null for non-directory items and for missing shared-parent context.
// Extracted from Offline.findParentAnyDirWithContext so sync and future reconcile code can reuse
// the conversion without needing an in-memory pathToItem map.
export function directoryDriveItemToAnyDirWithContext(item: DriveItem): OfflineParent | null {
	if (!isDirectoryItem(item)) {
		return null
	}

	switch (item.type) {
		case "directory": {
			return new AnyDirWithContext.Normal(new AnyNormalDir.Dir(item.data))
		}

		case "sharedDirectory": {
			const parentUuid = unwrapParentUuid(item.data.inner.parent)

			// Honor the OfflineParent | null contract: a missing parent must NOT throw here. This runs
			// for every nested entry inside an unguarded Promise.all in listDirectoriesRecursive, so a
			// single throw would reject the whole offline index rebuild. All callers handle null with
			// `if (!parent) continue`, so a missing-parent entry is skipped just like listFiles skips
			// an undecodable meta.
			if (!parentUuid) {
				return null
			}

			const parentDirFromCache = cache.directoryUuidToAnySharedDirWithContext.get(parentUuid)

			if (!parentDirFromCache) {
				return null
			}

			return new AnyDirWithContext.Shared(
				AnySharedDirWithContext.new({
					dir: new AnySharedDir.Dir(item.data),
					shareInfo: parentDirFromCache.shareInfo
				})
			)
		}

		case "sharedRootDirectory": {
			return new AnyDirWithContext.Shared(
				AnySharedDirWithContext.new({
					dir: new AnySharedDir.Root(item.data),
					shareInfo: item.data.sharingRole
				})
			)
		}
	}
}

// secureStore key for the "Sync offline files on Wi-Fi only" setting. Boolean; absent/false →
// preserves the prior always-sync behavior. Read in offlineSync.sync(); written by the offline
// settings screen via useSecureStore.
export const OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY = "offlineSyncWifiOnly"

// Whether offlineSync.sync() should bail for the current connection given the "Wi-Fi only" setting.
// Mirrors camera upload: only a metered cellular connection is blocked — wifi/ethernet/vpn/unknown
// still sync, so a misreported connection type can never falsely block a Wi-Fi sync.
export function shouldSkipOfflineSyncForConnection({
	wifiOnly,
	connectionType
}: {
	wifiOnly: boolean
	connectionType: string | null | undefined
}): boolean {
	return wifiOnly && connectionType === "cellular"
}

// One cached useDriveItemStoredOfflineQuery entry as enumerated from the TanStack query cache.
// Structural subset of TanStack's Query so the stale-entry scan below stays pure and dependency-free.
export type StoredOfflineQueryCacheEntry = {
	queryKey: readonly unknown[]
	state: {
		data: unknown
	}
}

// The storedOffline query cache is push-only (enabled: false, persisted to SQLite) — entries are
// never refetched, so a cached `true` for an item that vanished from the offline store wholesale
// (e.g. an OFFLINE_VERSION sweep) would otherwise stay `true` forever: a ghost "stored offline"
// badge for an item the offline screen doesn't list and whose menu offers neither offline action.
// Returns the {uuid, type} params of every cached entry claiming `true` whose uuid is NOT in the
// rebuilt index, so updateIndex can broadcast `false` for them. Query keys are
// [BASE_QUERY_KEY, { type: "file" | "directory", uuid }] with the type already normalized by the
// query module; malformed keys are skipped, never thrown on.
export function findStaleStoredOfflineEntries(
	cachedEntries: readonly StoredOfflineQueryCacheEntry[],
	index: {
		files: Record<string, unknown>
		directories: Record<string, unknown>
	}
): {
	uuid: string
	type: "file" | "directory"
}[] {
	const stale: {
		uuid: string
		type: "file" | "directory"
	}[] = []

	for (const entry of cachedEntries) {
		if (entry.state.data !== true) {
			continue
		}

		const params = entry.queryKey[1]

		if (typeof params !== "object" || params === null) {
			continue
		}

		const { uuid, type } = params as {
			uuid?: unknown
			type?: unknown
		}

		if (typeof uuid !== "string" || uuid.length === 0 || (type !== "file" && type !== "directory")) {
			continue
		}

		const stored = type === "file" ? index.files[uuid] : index.directories[uuid]

		if (!stored) {
			stale.push({
				uuid,
				type
			})
		}
	}

	return stale
}
