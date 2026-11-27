import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { canMoveVariant, canWriteVariant, type DriveVariant } from "@/features/drive/lib/preferences"
import { canShareVariant, isReadOnlySharedVariant } from "@/features/drive/lib/share/gating"
import { resolveDriveNavigationTarget } from "@/features/drive/lib/navigate"
import { canOpenAsText, canPreview, previewType } from "@/features/drive/lib/preview.logic"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { OFFLINE_REASON_KEY, type ActionDescriptor } from "@/lib/actionDescriptor"
import { type DriveKey } from "@/lib/i18n"

// Every action a drive item or selection can be offered, by the item menus, the bulk context menu, the selection bar and
// the listing's keys alike: one builder (driveSelectionActions) decides which, one dispatcher (selectionDispatch.ts) runs
// them.
export type DriveActionId =
	| "open"
	| "openAsText"
	| "extract"
	| "rename"
	| "move"
	| "copy"
	| "compress"
	| "favorite"
	| "color"
	| "versions"
	| "info"
	| "copyId"
	| "openContainingDirectory"
	| "download"
	| "downloadAs"
	| "addToPlaylist"
	| "share"
	| "publicLink"
	| "copyLink"
	| "disableLink"
	| "trash"
	| "unshare"
	| "restore"
	| "deletePermanently"

// The dialogs an action opens in the surface's dialog host, on the items it was offered for. "openAsText" opens the
// preview in its read-only text mode; "restoreSelected" is a selection's confirmed restore (one item restores directly);
// "compress"/"extract" the options dialogs, "extractTo" the extract destination picker, "addToNewPlaylist" the
// new-playlist name dialog that then adds the song(s).
export type DriveActionDialogKind =
	| "rename"
	| "move"
	| "copy"
	| "color"
	| "versions"
	| "info"
	| "link"
	| "share"
	| "unshare"
	| "trash"
	| "delete"
	| "restoreSelected"
	| "disableLink"
	| "openAsText"
	| "compress"
	| "extract"
	| "extractTo"
	| "addToNewPlaylist"

export type DriveActionDescriptor = ActionDescriptor<DriveKey, DriveActionId, DriveActionDialogKind>

// The keymap actions a surface's keys run each entry with (the drive listing's, the photos grid's, the preview
// overlay's), so every entry shows the key that does what it does. Move and Copy name their destination pickers' (the
// submenu entry the key opens); `copyToClipboard` Copy's clipboard entry where the surface binds its own. `deleteKey`:
// the surface's Delete, shown on whichever removal it runs here (driveDeleteKeyTarget).
export interface DriveActionShortcuts {
	readonly entries: Readonly<Partial<Record<DriveActionId, string>>>
	readonly copyToClipboard?: string
	readonly deleteKey?: string
}

// The drive listing's keys (features/drive/lib/keymap.ts).
export const DRIVE_ACTION_SHORTCUTS: DriveActionShortcuts = {
	entries: {
		open: "drive.open",
		openAsText: "drive.openAsText",
		rename: "drive.rename",
		move: "drive.move",
		copy: "drive.copyTo",
		compress: "drive.compress",
		extract: "drive.extract",
		favorite: "drive.toggleFavorite",
		color: "drive.color",
		versions: "drive.versions",
		info: "drive.info",
		openContainingDirectory: "drive.openContainingDirectory",
		download: "drive.download",
		downloadAs: "drive.downloadAs",
		copyLink: "drive.copyLink",
		share: "drive.share",
		restore: "drive.restore",
		deletePermanently: "drive.deletePermanently"
	},
	deleteKey: "drive.trash"
}

// What stays on the selection bar's face; everything else is in its overflow menu.
const PINNED_IDS: ReadonlySet<DriveActionId> = new Set([
	"download",
	"share",
	"move",
	"copy",
	"favorite",
	"trash",
	"restore",
	"deletePermanently"
])

// Every id whose run awaits an SDK call. A read dialog that renders local metadata (info) or its own query error state
// (versions) stays open offline, gating its own network sub-actions inside; Move and Copy are gated too, though their
// submenus open offline for the clipboard entries (each gates its own destinations).
const OFFLINE_GATED_IDS: ReadonlySet<DriveActionId> = new Set([
	"rename",
	"move",
	"favorite",
	"color",
	"publicLink",
	"copyLink",
	"disableLink",
	"share",
	"unshare",
	"trash",
	"restore",
	"deletePermanently",
	"openContainingDirectory",
	"download",
	"downloadAs",
	"copy",
	"compress",
	"extract",
	"addToPlaylist"
])

export interface DriveSelectionOptions {
	isOnline: boolean
	// One item only: a search hit whose parent is not the directory on screen, the only case "Open containing directory"
	// has somewhere to go.
	searchHit?: boolean | undefined
	// One item only: the caller can open it (a listing row, tile or the selection bar); the preview has it open already.
	open?: boolean | undefined
	shortcuts?: DriveActionShortcuts | undefined
}

// Whether opening the item (double-click, Enter, the menu's Open) does anything: a directory the listing
// can navigate into (never a trashed or undecryptable one), or a file with a preview. Audio opens the
// player rather than a preview, which a trashed track never does. directoryListing.tsx's open handler
// gates on this too, so the menu entry can never offer an inert open.
export function canOpenItem(item: DriveItem, variant: DriveVariant): boolean {
	if (isDirectoryItem(item)) {
		return resolveDriveNavigationTarget(item, variant, "") !== null
	}

	return canPreview(item) && !(variant === "trash" && previewType(item) === "audio")
}

// Whether the item is a directory things can be created in, uploaded into or pasted into from this
// listing — the same gate a file dropped on the row uploads by. Offline doesn't count against it: the
// menu shows those entries disabled then.
export function canWriteIntoItem(item: DriveItem, variant: DriveVariant): boolean {
	return isDirectoryItem(item) && !item.data.undecryptable && canWriteVariant(variant, item.data.uuid)
}

function entry(id: DriveActionId, def: keyof typeof ACTION_DEFS, kind?: DriveActionDialogKind): DriveActionDescriptor {
	return kind === undefined ? { id, ...ACTION_DEFS[def], run: "direct" } : { id, ...ACTION_DEFS[def], run: "dialog", dialogKind: kind }
}

// The gating alone, in menu order. One item gets the single-only entries (Open, Rename, Versions, Info, Copy ID, Open
// containing directory, Public link, Copy link); two or more get what applies to a whole selection.
function gatedActions(items: readonly DriveItem[], variant: DriveVariant, options: DriveSelectionOptions): DriveActionDescriptor[] {
	const single = items.length === 1 ? items[0] : undefined
	const flags = aggregateDriveSelectionFlags(items)
	const actions: DriveActionDescriptor[] = []

	if (single !== undefined && options.open === true) {
		if (canOpenItem(single, variant)) {
			actions.push(isDirectoryItem(single) ? entry("open", "openDirectory") : entry("open", "openFile"))
		} else if (canOpenAsText(single)) {
			actions.push(entry("openAsText", "openAsText", "openAsText"))
		}
	}

	// The trash offers only the two pure-uuid dispositions (no decrypted metadata needed, so undecryptable items too). One
	// item restores directly (mobile parity); a selection confirms first.
	if (variant === "trash") {
		actions.push(
			...(single === undefined
				? [entry("restore", "restore", "restoreSelected"), entry("deletePermanently", "deletePermanently", "delete")]
				: [
						entry("restore", "restore"),
						entry("deletePermanently", "deletePermanently", "delete"),
						entry("info", "info", "info"),
						entry("copyId", "copyId")
					])
		)

		return actions
	}

	// Owner-mutating entries are off only in Shared with me (isReadOnlySharedVariant): Shared by me holds the caller's
	// own items.
	const ownerMutable = !isReadOnlySharedVariant(variant)
	// Everything reading or writing decrypted metadata needs all of it; an undecryptable item's meta is ciphertext with no
	// content key. Pure-uuid entries (info, copy ID, trash, unshare, disable link) stay.
	const decryptable = !flags.includesUndecryptable

	// An archive's most likely action leads, right under Open. One archive has its options dialog; several are extracted
	// one job each to a picked destination.
	if (decryptable && flags.everyArchive) {
		actions.push(entry("extract", "extract", single === undefined ? "extractTo" : "extract"))
	}

	if (decryptable && ownerMutable) {
		if (single !== undefined) {
			actions.push(entry("rename", "rename", "rename"))
		}

		// Never in the links view: a link's row has no directory of its own to move from.
		if (canMoveVariant(variant)) {
			actions.push(entry("move", "move", "move"))
		}

		actions.push(
			entry("copy", "copy", "copy"),
			entry("compress", "compress", "compress"),
			// A selection's toggle SETS one state on all of it: unfavorite while any is favorited.
			entry("favorite", flags.includesFavorited ? "unfavorite" : "favorite")
		)

		// Color applies to own directories (setColor takes the plain arm, never a share's), one or several at once;
		// versions to one file.
		if (flags.everyDirectory) {
			actions.push(entry("color", "color", "color"))
		} else if (single !== undefined && !isDirectoryItem(single)) {
			actions.push(entry("versions", "versions", "versions"))
		}
	}

	if (single !== undefined) {
		actions.push(entry("info", "info", "info"), entry("copyId", "copyId"))

		if (decryptable && options.searchHit === true) {
			actions.push(entry("openContainingDirectory", "openContainingDirectory"))
		}
	}

	if (decryptable) {
		actions.push(entry("download", "download"))

		if (flags.everyDownloadAs) {
			actions.push(entry("downloadAs", "downloadAs"))
		}
	}

	// Any playable song in the selection; the rest is skipped by the add.
	if (flags.includesPlaylistSong) {
		actions.push(entry("addToPlaylist", "addToPlaylist"))
	}

	// Copying only reads, so Shared with me offers it too, beside the other read actions.
	if (decryptable && !ownerMutable) {
		actions.push(entry("copy", "copy", "copy"), entry("compress", "compress", "compress"))
	}

	// Granting a contact access needs an owned surface (canShareVariant excludes Shared with me).
	if (decryptable && canShareVariant(variant)) {
		actions.push(entry("share", "share", "share"))
	}

	if (decryptable && ownerMutable && single !== undefined) {
		actions.push(entry("publicLink", "publicLink", "link"))

		// Where every row is a linked item; elsewhere the link dialog shows and copies the link.
		if (variant === "links") {
			actions.push(entry("copyLink", "copyLink", "link"))
		}
	}

	// A link's status is keyed by uuid, not the item's metadata, so an undecryptable link is disabled too.
	if (variant === "links") {
		actions.push(entry("disableLink", "disableLink", "disableLink"))
	}

	// Recoverable, so never destructive-styled.
	if (ownerMutable) {
		actions.push(entry("trash", "trash", "trash"))
	}

	// removeSharedItem takes share roots only, which only the shared views' root listings hold.
	if (flags.everySharedRoot) {
		actions.push(entry("unshare", "unshare", "unshare"))
	}

	return actions
}

export type DriveDeleteKeyTarget = Extract<DriveActionId, "unshare" | "disableLink" | "trash">

// What the Delete key does to a selection offered `descriptors`: what takes the items out of the listing on screen. A
// share's root rows stop being shared (both shared views), a Links row's link is disabled, anything else goes to the
// trash. Nothing in the trash itself: deleting forever has its own, confirmed, key.
export function driveDeleteKeyTarget(descriptors: readonly Pick<DriveActionDescriptor, "id">[]): DriveDeleteKeyTarget | null {
	for (const id of ["unshare", "disableLink", "trash"] as const) {
		if (descriptors.some(descriptor => descriptor.id === id)) {
			return id
		}
	}

	return null
}

// The entries for `items` on `variant`: today's item menu for one, the selection's for several, each with its key, its
// offline state and whether the selection bar pins it. Empty for no items.
export function driveSelectionActions(
	items: readonly DriveItem[],
	variant: DriveVariant,
	options: DriveSelectionOptions
): DriveActionDescriptor[] {
	if (items.length === 0) {
		return []
	}

	const gated = gatedActions(items, variant, options)
	const shortcuts = options.shortcuts
	const deleteTarget = shortcuts?.deleteKey === undefined ? null : driveDeleteKeyTarget(gated)

	return gated.map(descriptor => {
		const kbdAction = shortcuts?.entries[descriptor.id] ?? (descriptor.id === deleteTarget ? shortcuts?.deleteKey : undefined)
		const offline = !options.isOnline && OFFLINE_GATED_IDS.has(descriptor.id)

		return {
			...descriptor,
			...(kbdAction === undefined ? {} : { kbdAction }),
			...(offline ? { enabled: false, disabledReasonKey: OFFLINE_REASON_KEY } : {}),
			...(PINNED_IDS.has(descriptor.id) ? { pinned: true } : {})
		}
	})
}

// Whether `descriptors` hold `id`, enabled: a key never runs what the menus would not.
export function offersAction(descriptors: readonly DriveActionDescriptor[], id: DriveActionId): DriveActionDescriptor | undefined {
	return descriptors.find(descriptor => descriptor.id === id && descriptor.enabled !== false)
}

// Groups the list for readability: a rule after the open group (Open or Open as text, then Extract), before the
// reference group (Info) and before whichever removal closes the list.
const SEPARATOR_BEFORE: ReadonlySet<DriveActionId> = new Set(["info", "trash", "deletePermanently"])
const OPEN_GROUP_IDS: ReadonlySet<DriveActionId> = new Set(["open", "openAsText", "extract"])

export function separatorBefore(descriptors: readonly Pick<DriveActionDescriptor, "id">[], index: number): boolean {
	const previous = descriptors[index - 1]
	const current = descriptors[index]

	return (
		previous !== undefined &&
		current !== undefined &&
		(SEPARATOR_BEFORE.has(current.id) || (OPEN_GROUP_IDS.has(previous.id) && !OPEN_GROUP_IDS.has(current.id)))
	)
}
