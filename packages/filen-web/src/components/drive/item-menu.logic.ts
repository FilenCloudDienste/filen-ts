import {
	PencilIcon,
	FolderInputIcon,
	StarIcon,
	StarOffIcon,
	PaletteIcon,
	HistoryIcon,
	InfoIcon,
	LinkIcon,
	CopyIcon,
	UsersIcon,
	UserMinusIcon,
	Trash2Icon,
	RotateCcwIcon,
	DownloadIcon,
	type LucideIcon
} from "lucide-react"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { canShareVariant, isSharedVariant } from "@/lib/share/gating"
import { type DriveKey } from "@/lib/i18n"
import { needsZip, startDownloads } from "@/lib/drive/download"

// Dialog kinds a per-item action can open in the listing-level dialog host (directory-listing.tsx's
// own activeDialog state). "emptyTrash" is a listing-level action (the trash toolbar, no per-item
// trigger), so it deliberately isn't part of this union — directory-listing.tsx's own ActiveDialog
// kind widens this with that one extra literal.
export type ItemActionDialogKind = "rename" | "move" | "color" | "versions" | "info" | "link" | "share" | "unshare" | "trash" | "delete"

export type ItemActionId =
	| "rename"
	| "move"
	| "favorite"
	| "color"
	| "versions"
	| "info"
	| "download"
	| "publicLink"
	| "copyLink"
	| "share"
	| "unshare"
	| "trash"
	| "restore"
	| "deletePermanently"

interface ItemActionDescriptorShared {
	id: ItemActionId
	labelKey: DriveKey
	icon: LucideIcon
	destructive?: boolean
	// Present-but-disabled (never absent) once set to false — omitted (default enabled) for every
	// descriptor that has no reason to ever disable itself. Today only "download" uses it: a dead
	// click is worse than a disabled control (see downloadDescriptor below).
	enabled?: boolean
}

// "direct" calls an action helper immediately (favorite/restore); "dialog" opens the listing's dialog host
// on the given kind — the two arms are mutually exclusive (a direct action has nowhere to route a
// dialogKind, a dialog action always needs one), modeled as a discriminated union rather than an
// optional field so a caller can never observe an inconsistent combination.
export type ItemActionDescriptor =
	(ItemActionDescriptorShared & { run: "direct" }) | (ItemActionDescriptorShared & { run: "dialog"; dialogKind: ItemActionDialogKind })

const RENAME: ItemActionDescriptor = { id: "rename", labelKey: "driveActionRename", icon: PencilIcon, run: "dialog", dialogKind: "rename" }
const MOVE: ItemActionDescriptor = { id: "move", labelKey: "driveActionMove", icon: FolderInputIcon, run: "dialog", dialogKind: "move" }
const COLOR: ItemActionDescriptor = { id: "color", labelKey: "driveActionColor", icon: PaletteIcon, run: "dialog", dialogKind: "color" }
const VERSIONS: ItemActionDescriptor = {
	id: "versions",
	labelKey: "driveActionVersions",
	icon: HistoryIcon,
	run: "dialog",
	dialogKind: "versions"
}
const INFO: ItemActionDescriptor = { id: "info", labelKey: "driveActionInfo", icon: InfoIcon, run: "dialog", dialogKind: "info" }
// Copy-link's real behavior (read existing link status, write the URL to the clipboard) needs
// link-status data this menu doesn't have — it deliberately dispatches the same dialog kind as
// Public link rather than duplicating that fetch here; the dialog's own Copy button IS copy-link's
// implementation.
const PUBLIC_LINK: ItemActionDescriptor = {
	id: "publicLink",
	labelKey: "driveActionPublicLink",
	icon: LinkIcon,
	run: "dialog",
	dialogKind: "link"
}
const COPY_LINK: ItemActionDescriptor = {
	id: "copyLink",
	labelKey: "driveActionCopyLink",
	icon: CopyIcon,
	run: "dialog",
	dialogKind: "link"
}
// Share the item with a Filen contact (opens the contact picker) — distinct from a public link (a
// URL anyone can open): this grants a specific existing contact access. Variant-gated (see
// canShareVariant / driveItemActions).
const SHARE: ItemActionDescriptor = { id: "share", labelKey: "driveActionShare", icon: UsersIcon, run: "dialog", dialogKind: "share" }
// Stop sharing a shared-root item (removeSharedItem) — root-only: gated below to the
// sharedRootDirectory/sharedRootFile arms alone, the only two arms that carry a `shareSource` (see
// item.ts's shareSource retention). Destructive-styled, mirroring mobile's own removeShare/
// stopSharing menu entries (both destructive there too) — the other party loses access immediately.
const UNSHARE: ItemActionDescriptor = {
	id: "unshare",
	labelKey: "driveActionUnshare",
	icon: UserMinusIcon,
	run: "dialog",
	dialogKind: "unshare",
	destructive: true
}
// Recoverable — not destructive-styled, matching the trash-confirm dialog it opens.
const TRASH: ItemActionDescriptor = { id: "trash", labelKey: "driveActionTrash", icon: Trash2Icon, run: "dialog", dialogKind: "trash" }
// A single item restores directly, no confirm (mobile parity — see driveRestoreSelectedConfirmTitle's
// own doc comment: that confirm is bulk-selection only).
const RESTORE: ItemActionDescriptor = { id: "restore", labelKey: "driveActionRestore", icon: RotateCcwIcon, run: "direct" }
const DELETE_PERMANENTLY: ItemActionDescriptor = {
	id: "deletePermanently",
	labelKey: "driveActionDeletePermanently",
	icon: Trash2Icon,
	run: "dialog",
	dialogKind: "delete",
	destructive: true
}

function favoriteDescriptor(item: DriveItem): ItemActionDescriptor {
	return item.data.favorited
		? { id: "favorite", labelKey: "driveActionUnfavorite", icon: StarOffIcon, run: "direct" }
		: { id: "favorite", labelKey: "driveActionFavorite", icon: StarIcon, run: "direct" }
}

// The single unifying download gate (mirrored in bulk-action-bar.logic.ts and the drive keymap):
// enabled iff `!needsZip([item])`, i.e. a file. A directory routes to the zip stub (not functional
// until a later task), so it stays present-but-disabled rather than vanishing from the menu — a dead
// click is worse than a disabled control.
function downloadDescriptor(item: DriveItem): ItemActionDescriptor {
	return { id: "download", labelKey: "driveActionDownload", icon: DownloadIcon, run: "direct", enabled: !needsZip([item]) }
}

// Download's "direct" action needs no await before it — startDownloads' FSA save picker requires the
// click's own live user gesture (see download.ts), and item-menu.tsx's onClick can't be exercised
// under this project's DOM-less vitest setup (vitest.config.ts's node environment), so this is the
// unit-testable seam proving the wiring: item-menu.tsx calls this synchronously off the click, never
// `await`ed.
export function startItemDownload(item: DriveItem): void {
	void startDownloads([item])
}

// Pure per-item menu builder shared by both the right-click context menu and the ⋯ dropdown (see
// item-menu.tsx) — same descriptor list either way, gated purely by variant/type/undecryptable so it
// stays trivially testable without rendering anything. Operates on a SINGLE item; bulk multi-select
// actions are the selection bar's own concern, not this menu's.
export function driveItemActions(item: DriveItem, variant: DriveVariant): ItemActionDescriptor[] {
	// Trash's own menu is already the maximally-reduced set (no rename/move/color/versions/link/
	// download regardless), so an undecryptable item here needs no further reduction — checked first
	// so that case never has to be special-cased below.
	if (variant === "trash") {
		return [RESTORE, DELETE_PERMANENTLY, INFO]
	}

	// Root-only — removeSharedItem has no nested-item shape (see item.ts's shareSource retention), so
	// a nested sharedDirectory/sharedFile never qualifies. This naturally confines Unshare to the
	// sharedIn/sharedOut ROOT listings, the only place a sharedRoot* arm ever appears. Independent of
	// the undecryptable reduction below — unshare needs no decrypted metadata (it acts on
	// shareSource's own identity), the same pure-uuid-disposition rationale as TRASH.
	const isSharedRoot = item.type === "sharedRootDirectory" || item.type === "sharedRootFile"

	// Every owner-mutating push below (rename/move/favorite/color/versions/publicLink/copyLink/trash)
	// is gated on ownerMutable, false for sharedIn/sharedOut — see isSharedVariant's own doc comment
	// for why both surfaces are excluded. What's left for those two: INFO always, SHARE when
	// canShareVariant allows it (sharedOut only), UNSHARE when isSharedRoot allows it (either surface).
	const ownerMutable = !isSharedVariant(variant)

	if (item.data.undecryptable) {
		const actions: ItemActionDescriptor[] = [INFO, downloadDescriptor(item)]

		if (ownerMutable) {
			actions.push(TRASH)
		}

		if (isSharedRoot) {
			actions.push(UNSHARE)
		}

		return actions
	}

	const actions: ItemActionDescriptor[] = ownerMutable
		? [RENAME, MOVE, favoriteDescriptor(item), asDirectoryOrFile(item).type === "directory" ? COLOR : VERSIONS, INFO]
		: [INFO]

	// Download sits right after Info (the other read/reference action) — offered on every surface this
	// point is reachable from, owned or shared alike, gated only by downloadDescriptor's own file/
	// directory check, never by ownerMutable/canShareVariant (download mutates nothing).
	actions.push(downloadDescriptor(item))

	// Share sits with the other access-granting actions (info/link) after the type-specific group; it
	// only appears on the owned surfaces (canShareVariant excludes sharedIn — you can't grant access to
	// an item you don't own — and, via the early returns above, trash and undecryptable items).
	if (canShareVariant(variant)) {
		actions.push(SHARE)
	}

	if (ownerMutable) {
		actions.push(PUBLIC_LINK, COPY_LINK, TRASH)
	}

	if (isSharedRoot) {
		actions.push(UNSHARE)
	}

	return actions
}
