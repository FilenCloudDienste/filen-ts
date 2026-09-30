import type { AnyDirWithContext } from "@filen/sdk-rs"
import { type DriveItem } from "@/types"
import { unwrapAnyDirUuid } from "@/lib/sdkUnwrap"
import { tryDriveItemToAnyDirWithContext } from "@/lib/sdkSources"
import { isDirectoryItem } from "@/features/drive/driveSelectors"
import * as FileSystem from "expo-file-system"
import { OFFLINE_DIRECTORIES_DIRECTORY } from "@/lib/storageRoots"
import { metaFileName } from "@/lib/metaFile"

// "sharedInRoot" means the item lives at the top level of Shared In (no parent dir, just the shared root listing).
export type OfflineParent = AnyDirWithContext | "sharedInRoot"

// uuid-only resolution for listing paths that hold no SDK context; the on-disk index needs nothing more.
export type OfflineUuidParent = { kind: "uuid"; uuid: string }

// Produces a stable string key from the deeply-nested AnyDirWithContext tagged union.
// Used to dedup parent listings in sync() and for the listDirectories cache.
export function parentCacheKey(parent: OfflineParent | OfflineUuidParent): string {
	if (typeof parent === "string") {
		return parent
	}

	if ("kind" in parent) {
		return `uuid:${parent.uuid}`
	}

	// The context tag keeps a normal and a shared/linked view of the same uuid apart; Dir vs Root needs no prefix.
	const uuid = unwrapAnyDirUuid(parent)

	if (uuid === null) {
		throw new Error("Unknown AnyDirWithContext tag")
	}

	return `${parent.tag}:${uuid}`
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
	// degraded still commits (verified-union meta). Download failures and missing-on-disk verify
	// failures are NEVER degraded (they block the commit). The one exception is a verify
	// SIZE-MISMATCH, which IS degraded and intentionally does NOT block — the remote content is
	// likely incomplete but the delivered bytes are committed (see reconcileTree verify-after-download).
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
	// Must not throw: it runs per nested entry inside an unguarded Promise.all in listDirectoriesRecursive, and callers skip null.
	return isDirectoryItem(item) ? tryDriveItemToAnyDirWithContext(item) : null
}

// secureStore key for the "Sync offline files on Wi-Fi only" setting. Boolean; absent/false →
// preserves the prior always-sync behavior. Read in offlineSync.sync(); written by the offline
// settings screen via useSecureStore.
export const OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY = "offlineSyncWifiOnly"

// secureStore key for the "Sync offline files in the background" setting. Boolean; absent/false →
// background task runs camera upload only (the prior behavior). Read by the background task;
// written by the offline settings screen via useSecureStore.
export const OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY = "offlineBackgroundSync"

// Background-pass budgets. The expensive unit of offline sync is the PER-TREE recursive listing —
// all-or-nothing per tree (a 10k-entry tree pays its full uniffi lift + meta parse the moment it
// is touched), so background passes gate WHICH trees run rather than aborting mid-tree. The
// tree-size metric is the .filenmeta FILE SIZE (one native stat per tree, zero parsing): the meta
// embeds the full flattened entries map, so its byte size is a faithful entry-count proxy
// (~1MB ≈ ~1k entries; campaign-measured 10k entries ≈ 6–12MB).
export const OFFLINE_BACKGROUND_TREE_META_SIZE_CAP_BYTES = 1_048_576
export const OFFLINE_BACKGROUND_CUMULATIVE_META_SIZE_CAP_BYTES = 4 * 1_048_576
export const OFFLINE_BACKGROUND_STANDALONE_FILE_CAP = 50

// One native stat for a stored tree's .filenmeta size — the background tree-selection metric.
// null when the meta is missing/unreadable (broken trees are left to the foreground heal pass).
// Plain concat is safe: both segments are uuid-derived ASCII (the encoding contract allows concat
// only for provably URI-safe segments).
export function getTreeMetaSize(topLevelUuid: string): number | null {
	try {
		const info = new FileSystem.File(`${OFFLINE_DIRECTORIES_DIRECTORY.uri}/${topLevelUuid}/${metaFileName(topLevelUuid)}`).info()

		if (!info.exists || typeof info.size !== "number") {
			return null
		}

		return info.size
	} catch {
		return null
	}
}

// Pure background tree selection: smallest metas first, per-tree size cap, cumulative budget.
// Trees with an unknown size (null — missing/unreadable meta) are NEVER selected in background;
// the foreground heal pass owns broken metas. Returns the SET of selected top-level uuids so the
// caller can filter its existing tree arrays without reordering them.
export function selectBackgroundTrees(
	trees: readonly {
		uuid: string
		metaSize: number | null
	}[],
	limits: {
		perTreeCapBytes: number
		cumulativeCapBytes: number
	} = {
		perTreeCapBytes: OFFLINE_BACKGROUND_TREE_META_SIZE_CAP_BYTES,
		cumulativeCapBytes: OFFLINE_BACKGROUND_CUMULATIVE_META_SIZE_CAP_BYTES
	}
): Set<string> {
	const eligible: {
		uuid: string
		metaSize: number
	}[] = []

	for (const tree of trees) {
		if (tree.metaSize !== null && tree.metaSize <= limits.perTreeCapBytes) {
			eligible.push({
				uuid: tree.uuid,
				metaSize: tree.metaSize
			})
		}
	}

	eligible.sort((a, b) => a.metaSize - b.metaSize)

	const selected = new Set<string>()
	let cumulative = 0

	for (const tree of eligible) {
		if (cumulative + tree.metaSize > limits.cumulativeCapBytes && selected.size > 0) {
			break
		}

		selected.add(tree.uuid)

		cumulative += tree.metaSize
	}

	return selected
}

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
