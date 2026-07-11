// English source catalog — "notes" namespace: the notes module shell (contextual sidebar with its two
// views, note rows, tag groups, search, view toggle, new-note affordance) and the placeholder editor
// card. Same typed-catalog rules as common/errors/auth/drive/contacts: flat `as const` object,
// camelCase keys, no literal '.' or ':' (real i18next namespaces, keySeparator/nsSeparator both ON).
// `moduleNotes` (the icon-rail label) stays in "common" — not duplicated here. Wording mirrors
// filen-mobile's notes feature where an equivalent surface exists.
export const notes = {
	// ── Sidebar header ───────────────────────────────────────────────────────
	/** Notes sidebar — header title over the list column */
	notesSidebarTitle: "Notes",
	/** Notes sidebar — header button that creates a new note; also its accessible label */
	notesNewNote: "New note",
	/** Notes sidebar — search box placeholder and accessible label (filters the active view) */
	notesSearch: "Search notes",
	/** Notes sidebar — clears the search box */
	notesSearchClear: "Clear search",

	// ── View toggle ────────────────────────────────────────────────────────────
	/** Notes sidebar — toggle option showing the flat note list */
	notesViewNotes: "Notes",
	/** Notes sidebar — toggle option showing tags as collapsible groups */
	notesViewTags: "Tags",
	/** Notes sidebar — accessible label for the notes/tags view toggle group */
	notesViewToggleLabel: "Sidebar view",

	// ── Note row affordances ───────────────────────────────────────────────────
	/** Note row — accessible label on the pinned indicator */
	notePinned: "Pinned",
	/** Note row — accessible label on the favorite indicator */
	noteFavorite: "Favorite",
	/** Note row — fallback title for a note that has no title yet */
	noteUntitled: "Untitled note",

	// ── Tag row ────────────────────────────────────────────────────────────────
	/** Tag group row — accessible label to expand the group and reveal its notes; {{name}} = tag name */
	notesTagExpand: "Expand {{name}}",
	/** Tag group row — accessible label to collapse the group; {{name}} = tag name */
	notesTagCollapse: "Collapse {{name}}",
	/** Tag group row — accessible label on the count badge; {{count}} = notes in the tag; singular */
	notesTagCount_one: "{{count}} note",
	/** Tag group row — accessible label on the count badge; {{count}} = notes in the tag; plural */
	notesTagCount_other: "{{count}} notes",
	/** Tag group row — accessible label on the favorite (starred) tag indicator */
	notesTagFavorite: "Favorite tag",

	// ── Empty states ───────────────────────────────────────────────────────────
	/** Notes view — empty-state title when the account has no notes at all */
	notesEmptyTitle: "No notes yet",
	/** Notes view — empty-state body under notesEmptyTitle */
	notesEmptyDescription: "Create a note to get started.",
	/** Tags view — empty-state title when the account has no tags at all */
	notesTagsEmptyTitle: "No tags yet",
	/** Tags view — empty-state body under notesTagsEmptyTitle */
	notesTagsEmptyDescription: "Tags you add to notes appear here.",
	/** Either view — title shown when a search yields no results */
	notesSearchEmptyTitle: "No results",
	/** Either view — body under notesSearchEmptyTitle */
	notesSearchEmptyDescription: "No matches for your search.",
	/** Sidebar — title shown when the notes list fails to load; the body is the failing query's own errorLabel */
	notesLoadError: "Couldn't load notes",

	// ── Editor placeholder card ────────────────────────────────────────────────
	/** Editor card — centered prompt when no note is selected */
	notesSelectPrompt: "Select a note",
	/** Editor card — body under notesSelectPrompt */
	notesSelectPromptDescription: "Choose a note from the list, or create a new one.",
	/** Editor card — centered muted state while the selected note's content is still loading */
	notesLoadingNote: "Loading note…",
	/** Editor card — title shown when the selected note's content fails to load; the body is the failing query's own errorLabel */
	notesContentLoadError: "Couldn't load note content",

	// ── Read-only content renderers ─────────────────────────────────────────────
	/** Checklist reader — centered muted state for a checklist note with no items yet */
	noteChecklistEmpty: "No checklist items yet",
	/** Markdown reader — accessible label on the draggable divider between the source and preview panes */
	noteMdSplitResize: "Resize markdown preview",

	// ── Note menu (noteMenu.tsx) ─────────────────────────────────────────────
	/** Note menu trigger — accessible label on the row/header ⋯ button, mirrors driveItemMenuTrigger */
	noteItemMenuTrigger: "More actions",
	/** Note menu — renames the note (opens noteRenameDialog) */
	noteActionRename: "Rename",
	/** Note menu — duplicates the note */
	noteActionDuplicate: "Duplicate",
	/** Note menu — pins the note to the top of the list */
	noteActionPin: "Pin",
	/** Note menu — unpins an already-pinned note */
	noteActionUnpin: "Unpin",
	/** Note menu — favorites the note */
	noteActionFavorite: "Favorite",
	/** Note menu — unfavorites an already-favorited note */
	noteActionUnfavorite: "Unfavorite",
	/** Note menu — opens the tags submenu (assign/unassign + create) */
	noteActionTags: "Tags",
	/** Note menu — tags submenu's inline entry that opens the create-tag dialog */
	noteActionCreateTag: "New tag",
	/** Note menu — opens the type submenu (text/md/code/rich/checklist) */
	noteActionType: "Change type",
	/** Note menu — opens the participants dialog (owner only; disabled placeholder until the dialogs wave) */
	noteActionParticipants: "Participants",
	/** Note menu — opens the history dialog (disabled placeholder until the dialogs wave) */
	noteActionHistory: "History",
	/** Note menu — archives the note (owner only) */
	noteActionArchive: "Archive",
	/** Note menu — restores an archived or trashed note */
	noteActionRestore: "Restore",
	/** Note menu — moves the note to the trash */
	noteActionTrash: "Trash",
	/** Note menu — permanently deletes a trashed note (opens noteDeleteDialog) */
	noteActionDeletePermanently: "Delete permanently",
	/** Note menu — a non-owner participant removes themselves from a shared note (opens noteLeaveDialog) */
	noteActionLeave: "Leave",

	// ── Type submenu ───────────────────────────────────────────────────────────
	/** Type submenu — the "text" note type */
	noteTypeText: "Text",
	/** Type submenu — the "md" (markdown) note type */
	noteTypeMd: "Markdown",
	/** Type submenu — the "code" note type */
	noteTypeCode: "Code",
	/** Type submenu — the "rich" (rich text) note type */
	noteTypeRich: "Rich text",
	/** Type submenu — the "checklist" note type */
	noteTypeChecklist: "Checklist",

	// ── Tag row menu (tagMenuActions) ──────────────────────────────────────────
	/** Tag row menu — renames the tag (opens noteTagRenameDialog) */
	noteTagActionRename: "Rename",
	/** Tag row menu — favorites the tag */
	noteTagActionFavorite: "Favorite",
	/** Tag row menu — unfavorites an already-favorited tag */
	noteTagActionUnfavorite: "Unfavorite",
	/** Tag row menu — deletes the tag (opens noteTagDeleteDialog); notes carrying it only lose the tag */
	noteTagActionDelete: "Delete",

	// ── Tags submenu ───────────────────────────────────────────────────────────
	/** Tags submenu — shown instead of the tag list when the account has no tags yet */
	noteTagsSubmenuEmpty: "No tags yet",
	/** createNoteTag/renameNoteTag — rejects a name colliding with a built-in pseudo-tag (all/favorites/pinned) */
	noteTagReservedName: "That name is reserved. Please choose another.",
	/** archiveNote — defense-in-depth owner gate, surfaced if the (owner-only) menu entry is ever reached without ownership */
	noteOwnerOnlyError: "Only the note owner can do this.",
	/** leaveNote — no resolved current-user id (account query cold); should not be reachable from the UI */
	noteNotSignedInError: "You're not signed in.",

	// ── Action dialogs ───────────────────────────────────────────────────────────
	/** Rename dialog — title */
	noteRenameDialogTitle: "Rename note",
	/** Rename dialog — body */
	noteRenameDialogBody: "Enter a new title.",
	/** Rename dialog — field label */
	noteRenameDialogLabel: "Title",
	/** Rename dialog — submit button */
	noteRenameDialogSubmit: "Rename",
	/** Delete-permanently confirm dialog — title */
	noteDeleteDialogTitle: "Delete permanently?",
	/** Delete-permanently confirm dialog — body */
	noteDeleteDialogBody: "Are you sure you want to permanently delete this note? This cannot be undone.",
	/** Leave confirm dialog — title */
	noteLeaveDialogTitle: "Leave note?",
	/** Leave confirm dialog — body */
	noteLeaveDialogBody: "Are you sure you want to leave this note? You will lose access to it.",
	/** Create-tag dialog — title */
	noteCreateTagDialogTitle: "New tag",
	/** Create-tag dialog — body */
	noteCreateTagDialogBody: "Enter a name for the new tag.",
	/** Create-tag dialog — field label */
	noteCreateTagDialogLabel: "Name",
	/** Create-tag dialog — field placeholder */
	noteCreateTagDialogPlaceholder: "Tag name",
	/** Create-tag dialog — submit button */
	noteCreateTagDialogSubmit: "Create",
	/** Rename-tag dialog — title */
	noteTagRenameDialogTitle: "Rename tag",
	/** Rename-tag dialog — body */
	noteTagRenameDialogBody: "Enter a new name.",
	/** Rename-tag dialog — field label */
	noteTagRenameDialogLabel: "Name",
	/** Rename-tag dialog — submit button */
	noteTagRenameDialogSubmit: "Rename",
	/** Delete-tag confirm dialog — title */
	noteTagDeleteDialogTitle: "Delete tag?",
	/** Delete-tag confirm dialog — body */
	noteTagDeleteDialogBody: "Notes carrying this tag are not deleted — they only lose the tag. This cannot be undone."
} as const
