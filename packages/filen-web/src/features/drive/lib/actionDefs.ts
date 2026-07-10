import {
	CopyIcon,
	DownloadIcon,
	FolderInputIcon,
	HistoryIcon,
	ImportIcon,
	InfoIcon,
	LinkIcon,
	PaletteIcon,
	PencilIcon,
	RotateCcwIcon,
	StarIcon,
	StarOffIcon,
	Trash2Icon,
	UserMinusIcon,
	UsersIcon,
	type LucideIcon
} from "lucide-react"
import { type DriveKey } from "@/lib/i18n"

export interface ActionDef {
	labelKey: DriveKey
	icon: LucideIcon
	destructive?: boolean
}

// Per-action label + icon (+ destructive styling) facts shared by the single-item menu
// (itemMenu.logic.ts) and the bulk-action bar (bulkActionBar.logic.ts) so the two builders can't
// drift on a label or icon. Each surface still owns its own ordering, gating, id naming (restore vs
// restoreSelected, deletePermanently vs delete) and run/dialogKind wiring — only these presentation
// facts are common. Favorite is two entries; each toggle picks by the item's/selection's favorited
// state.
export const ACTION_DEFS = {
	rename: { labelKey: "driveActionRename", icon: PencilIcon },
	move: { labelKey: "driveActionMove", icon: FolderInputIcon },
	favorite: { labelKey: "driveActionFavorite", icon: StarIcon },
	unfavorite: { labelKey: "driveActionUnfavorite", icon: StarOffIcon },
	color: { labelKey: "driveActionColor", icon: PaletteIcon },
	versions: { labelKey: "driveActionVersions", icon: HistoryIcon },
	info: { labelKey: "driveActionInfo", icon: InfoIcon },
	download: { labelKey: "driveActionDownload", icon: DownloadIcon },
	import: { labelKey: "driveActionImport", icon: ImportIcon },
	publicLink: { labelKey: "driveActionPublicLink", icon: LinkIcon },
	copyLink: { labelKey: "driveActionCopyLink", icon: CopyIcon },
	share: { labelKey: "driveActionShare", icon: UsersIcon },
	unshare: { labelKey: "driveActionUnshare", icon: UserMinusIcon, destructive: true },
	trash: { labelKey: "driveActionTrash", icon: Trash2Icon },
	restore: { labelKey: "driveActionRestore", icon: RotateCcwIcon },
	deletePermanently: { labelKey: "driveActionDeletePermanently", icon: Trash2Icon, destructive: true },
	emptyTrash: { labelKey: "driveActionEmptyTrash", icon: Trash2Icon, destructive: true }
} satisfies Record<string, ActionDef>
