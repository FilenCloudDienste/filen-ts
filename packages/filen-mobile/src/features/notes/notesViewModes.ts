import { type ComponentProps } from "react"
import type Ionicons from "@expo/vector-icons/Ionicons"
import { type Icons } from "@/components/ui/menuIcons"
import { type Note } from "@/types"
import { filterNotesMarkedOffline, filterNotesShared } from "@/features/notes/utils"

/**
 * Which list the notes tab renders.
 *
 * "offline" and "shared" are the same note rows as "notes", narrowed — the only way to see, audit
 * and bulk-manage each set, since the badges that identify them are otherwise scattered through the
 * full list. "tags" is the odd one out: a different list built from a different query.
 *
 * Everything that varies per mode lives in {@link NOTES_VIEW_MODES} and {@link narrowNotesForViewMode}
 * rather than in `===` chains at the call sites. Both are exhaustive over this union, so ADDING a
 * member here fails to compile until every decision is made for it. That is deliberate: a positive
 * `===` list silently stops matching a new mode, which is how the offline view once lost its header
 * menu (see the note in components/header.tsx).
 */
export type NotesViewMode = "notes" | "tags" | "offline" | "shared"

// Narrow literal unions, not `string`: t() only accepts registered catalog keys, so widening these
// would force a cast at every lookup and lose the compile-time check that the key exists.
type NotesViewModeTitleKey = "notes" | "tags" | "offline_view" | "shared_view"
type NotesViewModeMenuKey = "notes_view" | "tags_view" | "offline_view" | "shared_view"
type NotesViewModeEmptyTitleKey = "no_notes" | "no_tags" | "no_offline_notes" | "no_shared_notes"
type NotesViewModeEmptyDescriptionKey =
	| "no_notes_description"
	| "no_tags_description"
	| "no_offline_notes_description"
	| "no_shared_notes_description"

export type NotesViewModeDescriptor = {
	/** List title while this view is active. */
	titleKey: NotesViewModeTitleKey
	/** Label for this view's entry in the header's View submenu. */
	menuKey: NotesViewModeMenuKey
	/** Shown on the View submenu entry, and on the trigger for the active view. */
	icon: Icons
	/**
	 * Whether a note created from this view would actually land in the list the user is looking at.
	 * False for the narrowed views: a new note is neither kept on the device nor shared with anyone,
	 * so it would be absent from the list — indistinguishable from the action having failed. Gates
	 * both the header's create/import entries and the empty state's action button.
	 */
	allowsCreate: boolean
	empty: {
		icon: ComponentProps<typeof Ionicons>["name"]
		titleKey: NotesViewModeEmptyTitleKey
		descriptionKey: NotesViewModeEmptyDescriptionKey
	}
}

export const NOTES_VIEW_MODES: Record<NotesViewMode, NotesViewModeDescriptor> = {
	notes: {
		titleKey: "notes",
		menuKey: "notes_view",
		icon: "list",
		allowsCreate: true,
		empty: {
			icon: "document-text-outline",
			titleKey: "no_notes",
			descriptionKey: "no_notes_description"
		}
	},
	tags: {
		titleKey: "tags",
		menuKey: "tags_view",
		icon: "tag",
		// The tags view creates TAGS, not notes — its empty state carries its own action.
		allowsCreate: false,
		empty: {
			icon: "pricetag-outline",
			titleKey: "no_tags",
			descriptionKey: "no_tags_description"
		}
	},
	offline: {
		titleKey: "offline_view",
		menuKey: "offline_view",
		icon: "download",
		allowsCreate: false,
		empty: {
			icon: "download-outline",
			titleKey: "no_offline_notes",
			descriptionKey: "no_offline_notes_description"
		}
	},
	shared: {
		titleKey: "shared_view",
		menuKey: "shared_view",
		icon: "users",
		allowsCreate: false,
		empty: {
			icon: "people-outline",
			titleKey: "no_shared_notes",
			descriptionKey: "no_shared_notes_description"
		}
	}
}

/** The View submenu's order — declared once so the menu and this module cannot disagree. */
export const NOTES_VIEW_MODE_ORDER: NotesViewMode[] = ["notes", "tags", "offline", "shared"]

/**
 * The notes a view mode is built from, before grouping and search.
 *
 * Exhaustive by construction: the switch has no `default` and the return type excludes `undefined`,
 * so a new NotesViewMode member fails to compile here until its narrowing is spelled out — rather
 * than silently falling through to the unnarrowed list, which would show every note under the new
 * view's name.
 */
export function narrowNotesForViewMode({
	notes,
	viewMode,
	markedOffline,
	userId
}: {
	notes: readonly Note[]
	viewMode: NotesViewMode
	markedOffline: Record<string, true>
	userId: bigint | undefined
}): Note[] {
	switch (viewMode) {
		case "notes":
		case "tags": {
			// "tags" renders its own list from the tags query and never reaches here for the root
			// screen; a drilled-in tag screen resolves to "notes" and is narrowed by the sorter's own
			// tag filter instead.
			return notes as Note[]
		}

		case "offline": {
			return filterNotesMarkedOffline(notes, markedOffline)
		}

		case "shared": {
			return filterNotesShared(notes, userId)
		}
	}
}

/**
 * Whether the view can be built at all yet. The shared view classifies notes against the signed-in
 * user, so until that id is known its narrowing yields nothing — and an empty list under "No shared
 * notes" is a wrong answer, not a slow one. Every other view is answerable immediately.
 */
export function notesViewModeAwaitsUser({ viewMode, userId }: { viewMode: NotesViewMode; userId: bigint | undefined }): boolean {
	return viewMode === "shared" && userId === undefined
}
