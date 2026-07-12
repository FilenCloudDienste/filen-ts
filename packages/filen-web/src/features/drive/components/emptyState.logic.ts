import { FolderClosedIcon, HeartIcon, ClockIcon, UsersIcon, LinkIcon, Trash2Icon, type LucideIcon } from "lucide-react"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type DriveKey } from "@/lib/i18n"

export interface DriveEmptyStateCopy {
	icon: LucideIcon
	titleKey: DriveKey
	bodyKey: DriveKey
}

// Per-listing-surface empty-state icon + copy — mobile parity (filen-mobile's
// DRIVE_EMPTY_STATE_ICON/TITLE_KEY/DESCRIPTION_KEY tables in features/drive/utils.ts): one bespoke
// state per variant instead of a single generic pair reused everywhere. "drive" covers both My
// Drive's own root and any nested writable directory alike (mobile's folder_is_empty), and doubles as
// the picker's own empty-directory copy (emptyState.tsx's caller passes driveVariant="drive" there —
// the picker only ever browses the owned directory tree, never a flat listing).
const DRIVE_EMPTY_STATE: Record<DriveVariant, DriveEmptyStateCopy> = {
	drive: { icon: FolderClosedIcon, titleKey: "driveEmptyTitle", bodyKey: "driveEmptyBody" },
	trash: { icon: Trash2Icon, titleKey: "driveEmptyTrashTitle", bodyKey: "driveEmptyTrashBody" },
	favorites: { icon: HeartIcon, titleKey: "driveEmptyFavoritesTitle", bodyKey: "driveEmptyFavoritesBody" },
	recents: { icon: ClockIcon, titleKey: "driveEmptyRecentsTitle", bodyKey: "driveEmptyRecentsBody" },
	sharedIn: { icon: UsersIcon, titleKey: "driveEmptySharedInTitle", bodyKey: "driveEmptySharedInBody" },
	sharedOut: { icon: UsersIcon, titleKey: "driveEmptySharedOutTitle", bodyKey: "driveEmptySharedOutBody" },
	links: { icon: LinkIcon, titleKey: "driveEmptyLinksTitle", bodyKey: "driveEmptyLinksBody" }
}

export function driveEmptyStateCopy(variant: DriveVariant): DriveEmptyStateCopy {
	return DRIVE_EMPTY_STATE[variant]
}
