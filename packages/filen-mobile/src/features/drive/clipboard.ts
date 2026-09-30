import { ancestryHits } from "@filen/shared"
import { isDirectoryItem } from "@/features/drive/driveSelectors"
import type { DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"
import { normalParentUuidOf, unwrapParentUuid } from "@/lib/sdkUnwrap"
import cache from "@/lib/cache"

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
			const parentUuid = normalParentUuidOf(item)

			sharedParentUuid = sharedParentUuid === undefined || sharedParentUuid === parentUuid ? parentUuid : null
		}
	}

	const guard = { dirUuids, sharedParentUuid: sharedParentUuid ?? null }

	guards.set(entry, guard)

	return guard
}

// A directory's parent for ancestryHits, from the own directories' parent pointers: null at the root,
// undefined when uncached. The own-directory map, because the uuid→item map holds a shared-out
// directory as its shared variant.
export function cachedParentOf(uuid: string): string | null | undefined {
	if (uuid === cache.rootUuid) {
		return null
	}

	const dir = cache.getNormalDir(uuid)

	return dir ? unwrapParentUuid(dir.parent) : undefined
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

	return guard.dirUuids.size === 0 || ancestryHits(target, guard.dirUuids, cachedParentOf) === false
}
