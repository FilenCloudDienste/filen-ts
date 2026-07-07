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
	Trash2Icon,
	RotateCcwIcon,
	type LucideIcon
} from "lucide-react"
import { type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { type DriveKey } from "@/lib/i18n"

// Dialog kinds a per-item action can open in the listing-level dialog host (directory-listing.tsx's
// own activeDialog state). "emptyTrash" is a listing-level action (the trash toolbar, no per-item
// trigger), so it deliberately isn't part of this union — directory-listing.tsx's own ActiveDialog
// kind widens this with that one extra literal.
export type ItemActionDialogKind = "rename" | "move" | "color" | "versions" | "info" | "link" | "trash" | "delete"

export type ItemActionId =
	"rename" | "move" | "favorite" | "color" | "versions" | "info" | "publicLink" | "copyLink" | "trash" | "restore" | "deletePermanently"

interface ItemActionDescriptorShared {
	id: ItemActionId
	labelKey: DriveKey
	icon: LucideIcon
	destructive?: boolean
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
// link-status data a later step provides — until then it dispatches the same seam as Public link
// rather than acting on data this menu doesn't have.
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

// Pure per-item menu builder shared by both the right-click context menu and the ⋯ dropdown (see
// item-menu.tsx) — same descriptor list either way, gated purely by variant/type/undecryptable so it
// stays trivially testable without rendering anything. Operates on a SINGLE item; bulk multi-select
// actions are the selection bar's own concern, not this menu's.
export function driveItemActions(item: DriveItem, variant: DriveVariant): ItemActionDescriptor[] {
	// Trash's own menu is already the maximally-reduced set (no rename/move/color/versions/link
	// regardless), so an undecryptable item here needs no further reduction — checked first so that
	// case never has to be special-cased below.
	if (variant === "trash") {
		return [RESTORE, DELETE_PERMANENTLY, INFO]
	}

	if (item.data.undecryptable) {
		return [INFO, TRASH]
	}

	const typeSpecific = item.type === "directory" ? COLOR : VERSIONS

	return [RENAME, MOVE, favoriteDescriptor(item), typeSpecific, INFO, PUBLIC_LINK, COPY_LINK, TRASH]
}
