import { StarIcon, StarOffIcon, FolderInputIcon, Trash2Icon, RotateCcwIcon, type LucideIcon } from "lucide-react"
import { type DriveVariant } from "@/lib/drive/preferences"
import { type DriveSelectionFlags } from "@/lib/drive/selection-flags"
import { type DriveKey } from "@/lib/i18n"

// Dialog kinds the bulk-action bar can ask the listing's dialog host to open — a narrow subset of
// directory-listing.tsx's own ActiveDialogKind (the per-item-only kinds — rename/color/versions/info/
// link — can never be bulk-dispatched, so they have no place here).
export type BulkDialogActionKind = "move" | "trash" | "delete" | "restoreSelected"

interface BulkActionDescriptorShared {
	id: "favorite" | "move" | "trash" | "restoreSelected" | "delete"
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
// (variant/flag-gated descriptor list, trivially testable without rendering anything). Scoped to
// web's 4 variants (mobile's buildBulkActionMenu also covers sharedOut/sharedIn/links/offline, none
// of which exist on web yet).
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

	// Favorite/Unfavorite first — mirrors mobile's buildBulkActionMenu ordering (the most-tapped bulk
	// action leads). Gated by includesUndecryptable: both need decrypted metadata (favorite touches
	// the favorites-membership listing, keyed by name-independent uuid but still a metadata write).
	// Unlike a per-item toggle, the label/icon reflect the SET this bar will apply to the WHOLE
	// selection (`!flags.includesFavorited`), not any single item's own current flag.
	if (!flags.includesUndecryptable) {
		descriptors.push({
			id: "favorite",
			labelKey: flags.includesFavorited ? "driveActionUnfavorite" : "driveActionFavorite",
			icon: flags.includesFavorited ? StarOffIcon : StarIcon,
			run: "direct"
		})
		descriptors.push({ id: "move", labelKey: "driveActionMove", icon: FolderInputIcon, run: "dialog", dialogKind: "move" })
	}

	// Trash is NOT gated by undecryptable (pure uuid, same as restore/delete above) and is never
	// destructive-styled — recoverable, matching the per-item TRASH descriptor's own rationale.
	descriptors.push({ id: "trash", labelKey: "driveActionTrash", icon: Trash2Icon, run: "dialog", dialogKind: "trash" })

	return descriptors
}
