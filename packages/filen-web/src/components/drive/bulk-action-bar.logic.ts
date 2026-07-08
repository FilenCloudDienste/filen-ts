import {
	StarIcon,
	StarOffIcon,
	FolderInputIcon,
	UsersIcon,
	UserMinusIcon,
	Trash2Icon,
	RotateCcwIcon,
	DownloadIcon,
	type LucideIcon
} from "lucide-react"
import { type DriveVariant } from "@/lib/drive/preferences"
import { type DriveSelectionFlags } from "@/lib/drive/selection-flags"
import { canShareVariant, isSharedVariant } from "@/lib/share/gating"
import { type DriveKey } from "@/lib/i18n"
import { type DriveItem } from "@/lib/drive/item"
import { startDownloads } from "@/lib/drive/download"

// Dialog kinds the bulk-action bar can ask the listing's dialog host to open — a narrow subset of
// directory-listing.tsx's own ActiveDialogKind (the per-item-only kinds — rename/color/versions/info/
// link — can never be bulk-dispatched, so they have no place here). "share"/"unshare" are both
// bulk-dispatchable (the contact picker / unshare confirm each take the whole selection), unlike the
// other link/access kinds.
export type BulkDialogActionKind = "move" | "share" | "unshare" | "trash" | "delete" | "restoreSelected"

interface BulkActionDescriptorShared {
	id: "favorite" | "move" | "share" | "unshare" | "trash" | "restoreSelected" | "delete" | "download"
	labelKey: DriveKey
	icon: LucideIcon
	destructive?: boolean
}

// "direct" calls the bulk favorite SET helper immediately; "dialog" asks the host to open the given
// kind — mirrors item-menu.logic.ts's ItemActionDescriptor split (same rationale: a discriminated
// union instead of an optional field, so a caller can never observe an inconsistent combination).
export type BulkActionDescriptor =
	(BulkActionDescriptorShared & { run: "direct" }) | (BulkActionDescriptorShared & { run: "dialog"; dialogKind: BulkDialogActionKind })

// Pure gating builder for the bulk-action bar — mirrors item-menu.logic.ts's driveItemActions
// (variant/flag-gated descriptor list, trivially testable without rendering anything). Covers all 6
// web variants, sharedIn/sharedOut included (mobile's buildBulkActionMenu also covers links/offline,
// neither of which exist on web yet).
export function driveBulkActions(variant: DriveVariant, flags: DriveSelectionFlags): BulkActionDescriptor[] {
	// Trash's own bulk menu is the maximally-reduced set — restore (confirmed) and permanent delete,
	// neither gated by undecryptable (both are pure-uuid dispositions, no decrypted metadata needed).
	if (variant === "trash") {
		return [
			{ id: "restoreSelected", labelKey: "driveActionRestore", icon: RotateCcwIcon, run: "dialog", dialogKind: "restoreSelected" },
			{
				id: "delete",
				labelKey: "driveActionDeletePermanently",
				icon: Trash2Icon,
				destructive: true,
				run: "dialog",
				dialogKind: "delete"
			}
		]
	}

	const descriptors: BulkActionDescriptor[] = []

	// Favorite/move/trash are owner-mutating — gated off sharedIn/sharedOut entirely (isSharedVariant;
	// see item-menu.logic.ts's driveItemActions for the full per-surface rationale, mirrored here).
	// What's left for those two surfaces: SHARE (still undecryptable-gated below, sharedOut only via
	// canShareVariant) and UNSHARE (everySharedRoot, either surface).
	const ownerMutable = !isSharedVariant(variant)

	// Favorite/Unfavorite first — mirrors mobile's buildBulkActionMenu ordering (the most-tapped bulk
	// action leads). Gated by includesUndecryptable: both need decrypted metadata (favorite touches
	// the favorites-membership listing, keyed by name-independent uuid but still a metadata write).
	// Unlike a per-item toggle, the label/icon reflect the SET this bar will apply to the WHOLE
	// selection (`!flags.includesFavorited`), not any single item's own current flag.
	if (!flags.includesUndecryptable) {
		if (ownerMutable) {
			descriptors.push({
				id: "favorite",
				labelKey: flags.includesFavorited ? "driveActionUnfavorite" : "driveActionFavorite",
				icon: flags.includesFavorited ? StarOffIcon : StarIcon,
				run: "direct"
			})
			descriptors.push({ id: "move", labelKey: "driveActionMove", icon: FolderInputIcon, run: "dialog", dialogKind: "move" })
		}

		// Share the whole selection with contacts — same undecryptable gate as favorite/move above (an
		// undecryptable item can't be shared), plus the owned-surface variant gate (canShareVariant
		// excludes sharedIn; trash already returned above). Mirrors mobile's bulkShareFilenUser gating
		// (drive/recents/favorites/sharedOut, no undecryptable items).
		if (canShareVariant(variant)) {
			descriptors.push({ id: "share", labelKey: "driveActionShare", icon: UsersIcon, run: "dialog", dialogKind: "share" })
		}

		// Download shares the includesUndecryptable gate above (unlike favorite/move/share, it is never
		// gated on ownerMutable/canShareVariant — download mutates nothing): an undecryptable item's meta
		// is ciphertext with no content key, so it can never decrypt — a guaranteed-failing click, worse
		// than a disabled control. Offered on every non-trash, decryptable surface this point is
		// reachable from (owned or shared). Its own ENABLED state is a separate concern
		// (isBulkDownloadEnabled below) — this only controls presence, mirroring item-menu.logic.ts's
		// downloadDescriptor.
		descriptors.push({ id: "download", labelKey: "driveActionDownload", icon: DownloadIcon, run: "direct" })
	}

	// Trash is NOT gated by undecryptable (pure uuid, same as restore/delete above) and is never
	// destructive-styled — recoverable, matching the per-item TRASH descriptor's own rationale.
	if (ownerMutable) {
		descriptors.push({ id: "trash", labelKey: "driveActionTrash", icon: Trash2Icon, run: "dialog", dialogKind: "trash" })
	}

	// Root-only, same gate as the per-item menu's own UNSHARE (item-menu.logic.ts): only fires when
	// EVERY selected item is a sharedRootDirectory/sharedRootFile arm. Independent of includesUndecryptable
	// above — same pure-uuid-disposition rationale as trash — and destructive-styled, mirroring mobile's
	// removeShare/stopSharing menu entries.
	if (flags.everySharedRoot) {
		descriptors.push({
			id: "unshare",
			labelKey: "driveActionUnshare",
			icon: UserMinusIcon,
			destructive: true,
			run: "dialog",
			dialogKind: "unshare"
		})
	}

	return descriptors
}

// Download's ENABLED state (distinct from its PRESENCE in driveBulkActions above) — mirrored in
// item-menu.logic.ts and the drive keymap: enabled iff the selection is non-empty. The service-worker
// zip path removed the isFsaAvailable() requirement a dir/multi selection used to need — every
// selection downloads on every browser now, empty selections excepted.
export function isBulkDownloadEnabled(items: DriveItem[]): boolean {
	return items.length > 0
}

// Download's "direct" action needs no await before it — startDownloads' FSA save picker requires the
// click's own live user gesture (see lib/drive/download.ts), and bulk-action-bar.tsx's onClick can't
// be exercised under this project's DOM-less vitest setup, so this is the unit-testable seam proving
// the wiring: bulk-action-bar.tsx calls this synchronously off the click, never `await`ed.
export function startBulkDownload(items: DriveItem[]): void {
	void startDownloads(items)
}
