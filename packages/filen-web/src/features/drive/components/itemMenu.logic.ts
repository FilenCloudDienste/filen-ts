import { type LucideIcon } from "lucide-react"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { canMoveVariant, type DriveVariant } from "@/features/drive/lib/preferences"
import { canShareVariant, isSharedVariant } from "@/features/drive/lib/share/gating"
import { type DriveKey } from "@/lib/i18n"
import { startDownloads } from "@/features/drive/lib/download"

// Dialog kinds a per-item action can open in the listing-level dialog host (directoryListing.tsx's
// own activeDialog state). "emptyTrash" is a listing-level action (the trash toolbar, no per-item
// trigger), so it deliberately isn't part of this union — directoryListing.tsx's own ActiveDialog
// kind widens this with that one extra literal.
export type ItemActionDialogKind =
	"rename" | "move" | "color" | "versions" | "info" | "link" | "share" | "unshare" | "trash" | "delete" | "import"

export type ItemActionId =
	| "rename"
	| "move"
	| "favorite"
	| "color"
	| "versions"
	| "info"
	| "download"
	| "import"
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

const RENAME: ItemActionDescriptor = { id: "rename", ...ACTION_DEFS.rename, run: "dialog", dialogKind: "rename" }
const MOVE: ItemActionDescriptor = { id: "move", ...ACTION_DEFS.move, run: "dialog", dialogKind: "move" }
const COLOR: ItemActionDescriptor = { id: "color", ...ACTION_DEFS.color, run: "dialog", dialogKind: "color" }
const VERSIONS: ItemActionDescriptor = { id: "versions", ...ACTION_DEFS.versions, run: "dialog", dialogKind: "versions" }
const INFO: ItemActionDescriptor = { id: "info", ...ACTION_DEFS.info, run: "dialog", dialogKind: "info" }
// Copy-link's real behavior (read existing link status, write the URL to the clipboard) needs
// link-status data this menu doesn't have — it deliberately dispatches the same dialog kind as
// Public link rather than duplicating that fetch here; the dialog's own Copy button IS copy-link's
// implementation.
const PUBLIC_LINK: ItemActionDescriptor = { id: "publicLink", ...ACTION_DEFS.publicLink, run: "dialog", dialogKind: "link" }
const COPY_LINK: ItemActionDescriptor = { id: "copyLink", ...ACTION_DEFS.copyLink, run: "dialog", dialogKind: "link" }
// Share the item with a Filen contact (opens the contact picker) — distinct from a public link (a
// URL anyone can open): this grants a specific existing contact access. Variant-gated (see
// canShareVariant / driveItemActions).
const SHARE: ItemActionDescriptor = { id: "share", ...ACTION_DEFS.share, run: "dialog", dialogKind: "share" }
// Stop sharing a shared-root item (removeSharedItem) — root-only: gated below to the
// sharedRootDirectory/sharedRootFile arms alone, the only two whose shareSource is a SharedRootItem
// (see item.ts's shareSource retention) — removeSharedItem's own wasm signature. Destructive-styled
// (via ACTION_DEFS.unshare), mirroring mobile's own removeShare/stopSharing menu entries (both
// destructive there too) — the other party loses access immediately.
const UNSHARE: ItemActionDescriptor = { id: "unshare", ...ACTION_DEFS.unshare, run: "dialog", dialogKind: "unshare" }
// Recoverable — not destructive-styled, matching the trash-confirm dialog it opens.
const TRASH: ItemActionDescriptor = { id: "trash", ...ACTION_DEFS.trash, run: "dialog", dialogKind: "trash" }
// A single item restores directly, no confirm (mobile parity — see driveRestoreSelectedConfirmTitle's
// own doc comment: that confirm is bulk-selection only).
const RESTORE: ItemActionDescriptor = { id: "restore", ...ACTION_DEFS.restore, run: "direct" }
const DELETE_PERMANENTLY: ItemActionDescriptor = {
	id: "deletePermanently",
	...ACTION_DEFS.deletePermanently,
	run: "dialog",
	dialogKind: "delete"
}
// Copies an item you don't own into your own drive — sharedIn only (mobile parity: menuActionsDownload.ts's
// own Download > Import gates on `!isOwner`, and web has no equivalent of mobile's other gate,
// browsing a followed public link — see driveItemActions' own sharedIn-only push below). Opens the
// same destination picker as Move (moveTargetDialog.tsx's mode="import" branch) rather than a
// separate dialog.
const IMPORT: ItemActionDescriptor = { id: "import", ...ACTION_DEFS.import, run: "dialog", dialogKind: "import" }

function favoriteDescriptor(item: DriveItem): ItemActionDescriptor {
	return item.data.favorited
		? { id: "favorite", ...ACTION_DEFS.unfavorite, run: "direct" }
		: { id: "favorite", ...ACTION_DEFS.favorite, run: "direct" }
}

// Download is unconditionally enabled for any item that reaches this descriptor — the service-worker
// zip path means a dir/multi selection downloads on every browser now, not just Chromium's File System
// Access API. PRESENCE is still gated elsewhere (trash/undecryptable never reach this call site at
// all) — kept as an explicit field rather than omitted, mirroring the shared field's own doc comment.
function downloadDescriptor(): ItemActionDescriptor {
	return { id: "download", ...ACTION_DEFS.download, run: "direct", enabled: true }
}

// Download's "direct" action needs no await before it — startDownloads' FSA save picker requires the
// click's own live user gesture (see download.ts), and itemMenu.tsx's onClick can't be exercised
// under this project's DOM-less vitest setup (vitest.config.ts's node environment), so this is the
// unit-testable seam proving the wiring: itemMenu.tsx calls this synchronously off the click, never
// `await`ed.
export function startItemDownload(item: DriveItem): void {
	void startDownloads([item])
}

// Pure per-item menu builder shared by both the right-click context menu and the ⋯ dropdown (see
// itemMenu.tsx) — same descriptor list either way, gated purely by variant/type/undecryptable so it
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

	// Download is excluded here (unlike the general branch below): an undecryptable item's meta is the
	// ciphertext arm with no content key, so downloadFileToWriter can never decrypt it — a guaranteed
	// failure, worse than a disabled control. Same rationale as rename/move/favorite/etc. below, just
	// enforced by omission since download has no other reason to disable itself (see enabled? above).
	if (item.data.undecryptable) {
		const actions: ItemActionDescriptor[] = [INFO]

		if (ownerMutable) {
			actions.push(TRASH)
		}

		if (isSharedRoot) {
			actions.push(UNSHARE)
		}

		return actions
	}

	// MOVE is dropped in the links view (canMoveVariant) — see its own doc comment; the rest of the
	// owned-item set (rename/favorite/color|versions/link/download/trash) is offered there unchanged.
	const actions: ItemActionDescriptor[] = ownerMutable
		? [
				RENAME,
				...(canMoveVariant(variant) ? [MOVE] : []),
				favoriteDescriptor(item),
				asDirectoryOrFile(item).type === "directory" ? COLOR : VERSIONS,
				INFO
			]
		: [INFO]

	// Download sits right after Info (the other read/reference action) — offered on every surface this
	// point is reachable from, owned or shared alike, never gated by ownerMutable/canShareVariant
	// (download mutates nothing).
	actions.push(downloadDescriptor())

	// Import sits right after Download (mobile parity — menuActionsDownload.ts nests Import inside the
	// same Download submenu) — sharedIn ONLY, root or nested alike: sharedOut is excluded (you already
	// own those items — isOwner is true there on mobile too, see IMPORT's own doc comment), and every
	// owner-mutating surface below never reaches sharedIn in the first place (ownerMutable is false).
	if (variant === "sharedIn") {
		actions.push(IMPORT)
	}

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
