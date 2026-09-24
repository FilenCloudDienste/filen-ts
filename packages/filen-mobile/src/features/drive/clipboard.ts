import { AnyNormalDir_Tags, type AnyNormalDir } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import type { CopyDestination } from "@/features/copy/copyAdapter"
import type { DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"
import { everyItemAlreadyIn } from "@/features/drive/driveSelectors"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import cache from "@/lib/cache"

// Deep enough for any real tree; a longer chain is treated as unresolved.
const MAX_ANCESTRY_DEPTH = 64

function isDirectoryItem(item: DriveItem): boolean {
	return item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
}

function parentUuidOf(item: DriveItem): string | null {
	return item.type === "file" || item.type === "directory" ? unwrapParentUuid(item.data.parent) : null
}

// Whether `targetUuid` lies inside (or is) one of `dirUuids`, walking cached parent pointers up to the
// root. "unresolved" when a link is missing from the cache: a directory paste is then refused rather
// than risked.
export function ancestryHits(targetUuid: string, dirUuids: ReadonlySet<string>, rootUuid: string | null): boolean | "unresolved" {
	let uuid: string | null = targetUuid

	for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
		if (uuid === null || uuid === rootUuid) {
			return false
		}

		if (dirUuids.has(uuid)) {
			return true
		}

		const item = cache.uuidToAnyDriveItem.get(uuid)

		if (!item || item.type !== "directory") {
			return "unresolved"
		}

		uuid = unwrapParentUuid(item.data.parent)
	}

	return "unresolved"
}

// A paste lands in `targetUuid` (null = the drive root). A directory can't land in itself or below it,
// and a cut is a move within the own drive (`allowCut`) that must move at least one item.
export function canPasteInto({
	entry,
	targetUuid,
	allowCut
}: {
	entry: DriveClipboardEntry | null
	targetUuid: string | null
	allowCut: boolean
}): boolean {
	if (entry === null || entry.items.length === 0) {
		return false
	}

	const rootUuid = cache.rootUuid
	const target = targetUuid ?? rootUuid

	if (entry.mode === "cut" && (!allowCut || (target !== null && everyItemAlreadyIn(entry.items, target, parentUuidOf)))) {
		return false
	}

	if (target === null) {
		return true
	}

	const dirUuids = new Set(entry.items.filter(isDirectoryItem).map(item => item.data.uuid))

	return dirUuids.size === 0 || ancestryHits(target, dirUuids, rootUuid) === false
}

// The copy destination a directory stands for: the root as { uuid: null } under `rootName`.
export function copyDestinationOf(dir: AnyNormalDir, rootUuid: string | null, rootName: string): CopyDestination {
	const uuid = dir.inner[0].uuid

	return dir.tag === AnyNormalDir_Tags.Root || uuid === rootUuid
		? { uuid: null, name: rootName }
		: { uuid, name: cache.uuidToAnyDriveItem.get(uuid)?.data.decryptedMeta?.name ?? uuid }
}
