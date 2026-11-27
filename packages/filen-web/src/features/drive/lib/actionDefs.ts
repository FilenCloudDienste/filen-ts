import {
	ArchiveIcon,
	CopyIcon,
	CopyPlusIcon,
	DownloadIcon,
	EyeIcon,
	FileDownIcon,
	FileTextIcon,
	FolderInputIcon,
	FolderOpenIcon,
	HashIcon,
	HistoryIcon,
	InfoIcon,
	Link2OffIcon,
	LinkIcon,
	ListMusicIcon,
	PackageOpenIcon,
	PaletteIcon,
	PencilIcon,
	RotateCcwIcon,
	StarIcon,
	StarOffIcon,
	Trash2Icon,
	UserMinusIcon,
	UsersIcon
} from "lucide-react"
import { type ActionDef } from "@/lib/actionDescriptor"
import { type DriveKey } from "@/lib/i18n"

// Per-action label + icon (+ destructive styling) facts shared by the drive builder (selectionActions.ts) and the public
// links' (publicLinks/lib/browse.logic.ts), so no surface drifts on a label or icon. Favorite is two entries; each toggle picks by the item's/selection's favorited
// state.
export const ACTION_DEFS = {
	// Open is two entries, picked by item type like favorite: a directory navigates, a file previews.
	openDirectory: { labelKey: "driveActionOpen", icon: FolderOpenIcon },
	openFile: { labelKey: "driveActionOpen", icon: EyeIcon },
	openAsText: { labelKey: "driveActionOpenAsText", icon: FileTextIcon },
	rename: { labelKey: "driveActionRename", icon: PencilIcon },
	move: { labelKey: "driveActionMove", icon: FolderInputIcon },
	// Not CopyIcon: that one already means "Copy link".
	copy: { labelKey: "driveActionCopy", icon: CopyPlusIcon },
	compress: { labelKey: "driveActionCompress", icon: ArchiveIcon },
	extract: { labelKey: "driveActionExtract", icon: PackageOpenIcon },
	favorite: { labelKey: "driveActionFavorite", icon: StarIcon },
	unfavorite: { labelKey: "driveActionUnfavorite", icon: StarOffIcon },
	color: { labelKey: "driveActionColor", icon: PaletteIcon },
	versions: { labelKey: "driveActionVersions", icon: HistoryIcon },
	info: { labelKey: "driveActionInfo", icon: InfoIcon },
	copyId: { labelKey: "driveActionCopyId", icon: HashIcon },
	openContainingDirectory: { labelKey: "driveActionOpenContainingDirectory", icon: FolderOpenIcon },
	download: { labelKey: "driveActionDownload", icon: DownloadIcon },
	// A submenu of export formats (downloadAsSubmenu.tsx), offered beside Download.
	downloadAs: { labelKey: "driveActionDownloadAs", icon: FileDownIcon },
	// A submenu of the user's playlists (addToPlaylistSubmenu.tsx), offered only where a playable song is picked.
	addToPlaylist: { labelKey: "driveActionAddToPlaylist", icon: ListMusicIcon },
	publicLink: { labelKey: "driveActionPublicLink", icon: LinkIcon },
	copyLink: { labelKey: "driveActionCopyLink", icon: CopyIcon },
	share: { labelKey: "driveActionShare", icon: UsersIcon },
	unshare: { labelKey: "driveActionUnshare", icon: UserMinusIcon, destructive: true },
	trash: { labelKey: "driveActionTrash", icon: Trash2Icon },
	restore: { labelKey: "driveActionRestore", icon: RotateCcwIcon },
	deletePermanently: { labelKey: "driveActionDeletePermanently", icon: Trash2Icon, destructive: true },
	emptyTrash: { labelKey: "driveActionEmptyTrash", icon: Trash2Icon, destructive: true },
	disableLink: { labelKey: "driveLinkDisableAction", icon: Link2OffIcon, destructive: true }
} satisfies Record<string, ActionDef<DriveKey>>
