import { DOT_FILEN_DIR_NAME, isRootDotFilen, type RootDotFilenFilter } from "@filen/shared"
import cache from "@/lib/cache"
import alerts from "@/lib/alerts"
import { t } from "@/lib/i18n"
import { inputPrompt } from "@/lib/promptFlow"
import { normalParentUuidOf, trashedFromParentUuid } from "@/lib/sdkUnwrap"
import { getKnownDotFilenUuid, isKnownDotFilenDir } from "@/lib/dotFilenKnown"
import { type DrivePath } from "@/hooks/useDrivePath"
import { type DriveItem } from "@/types"

// Trashing, deleting, moving or renaming the root `.filen` (Filen's own synced settings) is never blocked, only
// confirmed by typing its name. The native prompt can't hold its button disabled until the text matches, so the
// text is checked when it is confirmed: anything else changes nothing and says so.

export type DotFilenOperation = "trash" | "delete" | "move" | "rename"

const TITLE_KEYS = {
	trash: "dot_filen_trash_title",
	delete: "dot_filen_delete_title",
	move: "dot_filen_move_title",
	rename: "dot_filen_rename_title"
} as const

const CONFIRM_KEYS = {
	trash: "dot_filen_trash_confirm",
	delete: "dot_filen_delete_confirm",
	move: "dot_filen_move_confirm",
	rename: "dot_filen_rename_confirm"
} as const

// By the uuid the resolver holds, else by name and place; a trashed one by the parent its trash marker remembers.
export function isRootDotFilenItem(item: DriveItem): boolean {
	if (item.type !== "directory") {
		return false
	}

	if (item.data.uuid === getKnownDotFilenUuid()) {
		return true
	}

	return isRootDotFilen({
		name: item.data.decryptedMeta?.name ?? "",
		parentUuid: unwrapParentUuidOrTrashed(item),
		rootUuid: cache.rootUuid
	})
}

function unwrapParentUuidOrTrashed(item: Extract<DriveItem, { type: "directory" }>): string | null {
	return normalParentUuidOf(item) ?? trashedFromParentUuid(item.data.parent)
}

export function includesRootDotFilen(items: readonly DriveItem[]): boolean {
	return items.some(isRootDotFilenItem)
}

function directoryParentOf(item: DriveItem): string | null {
	return item.type === "directory" ? normalParentUuidOf(item) : null
}

// Recents and favorites gather `.filen`'s own files (settings, playlists, chat uploads) next to the user's.
function insideDotFilen(item: DriveItem): boolean {
	const parent = normalParentUuidOf(item)

	return parent !== null && isKnownDotFilenDir(parent)
}

/**
 * The shared filter's root `.filen` rule (filterHiddenItems' `rootDotFilen`), or undefined where nothing is hidden:
 * the setting shows it (useShowDotFilen), the root isn't known yet, or the root `.filen` can't appear here. It can at
 * the drive root (a search rooted there included; the pickers too) and at the flat recents, favorites and links
 * roots; never in a subdirectory, and the trash keeps a trashed one restorable.
 */
export function rootDotFilenFilter({ show, drivePath }: { show: boolean; drivePath: DrivePath }): RootDotFilenFilter<DriveItem> | undefined {
	const rootUuid = cache.rootUuid

	if (show || rootUuid === null) {
		return undefined
	}

	switch (drivePath.type) {
		case "drive":
			return drivePath.uuid === null || drivePath.uuid === rootUuid ? { rootUuid, directoryParentOf, searchAtDriveRoot: true } : undefined
		// The flat roots only: a directory browsed into from one is a subdirectory listing.
		case "recents":
		case "favorites":
			return drivePath.uuid === null ? { rootUuid, directoryParentOf, searchAtDriveRoot: false, insideDotFilen } : undefined
		case "links":
			return drivePath.uuid === null ? { rootUuid, directoryParentOf, searchAtDriveRoot: false } : undefined
		default:
			return undefined
	}
}

// The empty-trash confirmation's message, saying so when the trash holds the root `.filen`.
export function emptyTrashMessage(trashItems: readonly DriveItem[]): string {
	const message = t("are_you_sure_empty_trash")

	return includesRootDotFilen(trashItems) ? `${message}\n\n${t("empty_trash_dot_filen_note", { name: DOT_FILEN_DIR_NAME })}` : message
}

// True to go on: `items` hold no root `.filen`, or the user typed its name.
export async function confirmDotFilenOperation(operation: DotFilenOperation, items: readonly DriveItem[]): Promise<boolean> {
	if (!includesRootDotFilen(items)) {
		return true
	}

	const values = { name: DOT_FILEN_DIR_NAME }
	const typed = await inputPrompt(
		{
			title: t(TITLE_KEYS[operation], values),
			message: items.length > 1 ? t("dot_filen_message_selection", values) : t("dot_filen_message", values),
			placeholder: DOT_FILEN_DIR_NAME,
			cancelText: t("cancel"),
			okText: t(CONFIRM_KEYS[operation]),
			destructive: true,
			// The address keyboard leaves the typed name as typed: no capital after the dot, no autocorrect.
			keyboardType: "email-address"
		},
		{ tag: "dotFilen", message: "confirm prompt failed" },
		{ trim: true }
	)

	if (typed === null) {
		return false
	}

	if (typed !== DOT_FILEN_DIR_NAME) {
		alerts.normal(t("dot_filen_confirm_mismatch", values))

		return false
	}

	return true
}
