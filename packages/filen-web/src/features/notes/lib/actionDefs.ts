import {
	PencilIcon,
	CopyIcon,
	PinIcon,
	PinOffIcon,
	HeartIcon,
	HeartOffIcon,
	TagIcon,
	FileTypeIcon,
	UsersIcon,
	HistoryIcon,
	ArchiveIcon,
	ArchiveRestoreIcon,
	Trash2Icon,
	LogOutIcon,
	PlusIcon,
	StarIcon,
	StarOffIcon,
	type LucideIcon
} from "lucide-react"
import { type NotesKey } from "@/lib/i18n"

export interface NoteActionDef {
	labelKey: NotesKey
	icon: LucideIcon
	destructive?: boolean
}

// Per-action label + icon (+ destructive styling) facts for the note menu (noteMenu.logic.ts), mirroring
// drive's ACTION_DEFS split: one place a label/icon can drift from, gating/ordering stays the builder's
// own concern. Pin/favorite are two entries each; the builder picks by the note's current flag.
export const NOTE_ACTION_DEFS = {
	rename: { labelKey: "noteActionRename", icon: PencilIcon },
	duplicate: { labelKey: "noteActionDuplicate", icon: CopyIcon },
	pin: { labelKey: "noteActionPin", icon: PinIcon },
	unpin: { labelKey: "noteActionUnpin", icon: PinOffIcon },
	favorite: { labelKey: "noteActionFavorite", icon: HeartIcon },
	unfavorite: { labelKey: "noteActionUnfavorite", icon: HeartOffIcon },
	tags: { labelKey: "noteActionTags", icon: TagIcon },
	createTag: { labelKey: "noteActionCreateTag", icon: PlusIcon },
	type: { labelKey: "noteActionType", icon: FileTypeIcon },
	participants: { labelKey: "noteActionParticipants", icon: UsersIcon },
	history: { labelKey: "noteActionHistory", icon: HistoryIcon },
	archive: { labelKey: "noteActionArchive", icon: ArchiveIcon },
	restore: { labelKey: "noteActionRestore", icon: ArchiveRestoreIcon },
	trash: { labelKey: "noteActionTrash", icon: Trash2Icon },
	deletePermanently: { labelKey: "noteActionDeletePermanently", icon: Trash2Icon, destructive: true },
	leave: { labelKey: "noteActionLeave", icon: LogOutIcon, destructive: true },
	// Tag-row menu (tagMenuActions) — Star, not Heart: matches the tag row's own favorite indicator
	// (notesSidebar.tsx renders a StarIcon on favorited tags; notes use hearts, tags use stars).
	tagRename: { labelKey: "noteTagActionRename", icon: PencilIcon },
	tagFavorite: { labelKey: "noteTagActionFavorite", icon: StarIcon },
	tagUnfavorite: { labelKey: "noteTagActionUnfavorite", icon: StarOffIcon },
	tagDelete: { labelKey: "noteTagActionDelete", icon: Trash2Icon, destructive: true }
} satisfies Record<string, NoteActionDef>
