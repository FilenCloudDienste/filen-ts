import { AnyNormalDir_Tags, type AnyNormalDir } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import type { CopyDestination } from "@/features/copy/copyAdapter"
import type { DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"
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

type PasteGuard = {
	// The clipboard's directories: a paste can't land in any of them or below.
	dirUuids: ReadonlySet<string>
	// For a cut, the directory every item sits in when they all share one (a cut there moves nothing); else null.
	sharedParentUuid: string | null
}

// Directory rows run the guard on every render, so it is derived once per clipboard entry.
const guards = new WeakMap<DriveClipboardEntry, PasteGuard>()

function pasteGuardOf(entry: DriveClipboardEntry): PasteGuard {
	const cached = guards.get(entry)

	if (cached) {
		return cached
	}

	const dirUuids = new Set<string>()
	let sharedParentUuid: string | null | undefined = undefined

	for (const item of entry.items) {
		if (isDirectoryItem(item)) {
			dirUuids.add(item.data.uuid)
		}

		if (entry.mode === "cut") {
			const parentUuid = parentUuidOf(item)

			sharedParentUuid = sharedParentUuid === undefined || sharedParentUuid === parentUuid ? parentUuid : null
		}
	}

	const guard = { dirUuids, sharedParentUuid: sharedParentUuid ?? null }

	guards.set(entry, guard)

	return guard
}

// Whether `targetUuid` lies inside (or is) one of `dirUuids`, walking the own directories' parent
// pointers up to the root. The own-directory map, because the uuid→item map holds a shared-out
// directory as its shared variant. "unresolved" when a link is missing: a directory paste is then
// refused rather than risked.
export function ancestryHits(targetUuid: string, dirUuids: ReadonlySet<string>, rootUuid: string | null): boolean | "unresolved" {
	let uuid: string | null = targetUuid

	for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
		if (uuid === null || uuid === rootUuid) {
			return false
		}

		if (dirUuids.has(uuid)) {
			return true
		}

		const dir = cache.directoryUuidToAnyNormalDir.get(uuid)

		if (!dir || dir.tag !== AnyNormalDir_Tags.Dir) {
			return "unresolved"
		}

		uuid = unwrapParentUuid(dir.inner[0].parent)
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
	if (entry.mode === "cut" && !allowCut) {
		return false
	}

	const guard = pasteGuardOf(entry)

	if (entry.mode === "cut" && target !== null && guard.sharedParentUuid === target) {
		return false
	}

	if (target === null) {
		return true
	}

	return guard.dirUuids.size === 0 || ancestryHits(target, guard.dirUuids, rootUuid) === false
}

// The copy destination a directory stands for: the root as { uuid: null } under `rootName`.
export function copyDestinationOf(dir: AnyNormalDir, rootUuid: string | null, rootName: string): CopyDestination {
	const uuid = dir.inner[0].uuid

	return dir.tag === AnyNormalDir_Tags.Root || uuid === rootUuid
		? { uuid: null, name: rootName }
		: { uuid, name: cache.uuidToAnyDriveItem.get(uuid)?.data.decryptedMeta?.name ?? uuid }
}
