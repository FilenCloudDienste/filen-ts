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
	/** Notes sidebar — header ⋯ trigger next to "New note", opens the bulk-ops menu */
	notesSidebarMoreActions: "More options",
	/** Notes sidebar bulk-ops menu — downloads every non-trashed note as one archive */
	notesExportAllAction: "Export all",
	/** Notes sidebar bulk-ops menu — the downloaded archive's own file name */
	notesExportAllFilename: "Notes.zip",
	/** Notes sidebar bulk-ops menu — opens the file picker to import a note from a text/markdown/code/html file */
	notesImportAction: "Import note",
	/** importNoteFromFile — the picked file's extension doesn't match any recognized note type */
	noteImportUnsupportedType: "This file type isn't supported for import.",

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
	/** Note row — metadata line shown on a note shared TO you; {{email}} = the owning participant's email */
	noteSharedByEmail: "Shared by {{email}}",

	// ── Notes-view date grouping (section headers) ─────────────────────────────
	// First-match-wins partition, notes view only (the tags view stays ungrouped). Empty sections
	// never render. Pinned/Favorited remove a note from its date bucket. Month and year headers use a
	// computed label (Intl month name / the year), not a key.
	/** Group header — pinned notes */
	notesGroupPinned: "Pinned",
	/** Group header — favorited notes */
	notesGroupFavorited: "Favorited",
	/** Group header — edited within the last 24 hours */
	notesGroupToday: "Today",
	/** Group header — edited within the last 7 days */
	notesGroupPrevious7Days: "Previous 7 days",
	/** Group header — edited within the last 30 days */
	notesGroupPrevious30Days: "Previous 30 days",
	/** Group header — archived notes */
	notesGroupArchived: "Archived",
	/** Group header — trashed notes */
	notesGroupTrashed: "Trashed",
	/** Notes sidebar — accessible label on the trailing-edge drag handle that resizes the sidebar */
	notesSidebarResize: "Resize sidebar",

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

	// ── Tags-view sort control ──────────────────────────────────────────────────
	/** Tags-view sort menu — trigger button's accessible label and the field group's own heading */
	notesTagsSortMenuLabel: "Sort tags",
	/** Tags-view sort menu — sort by each tag's most recently edited note */
	notesTagsSortLastActivity: "Last activity",
	/** Tags-view sort menu — sort by tag name */
	notesTagsSortName: "Name",
	/** Tags-view sort menu — sort by how many notes carry the tag */
	notesTagsSortNotesCount: "Note count",
	/** Tags-view sort menu — ascending direction option */
	notesTagsSortAscending: "Ascending",
	/** Tags-view sort menu — descending direction option */
	notesTagsSortDescending: "Descending",

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

	// ── Editor (live editing) ────────────────────────────────────────────────────
	/** Editor header — accessible label on the sync spinner shown while the note's edit is in flight */
	noteSyncing: "Saving…",
	/** Editor — banner shown when a note has reached its maximum size; further edits are not saved */
	noteSizeLimitReached: "This note has reached its maximum size. New changes won't be saved until you shorten it.",
	/** Keymap — description for the Cmd/Ctrl+S action that flushes the pending save immediately */
	notesSaveAction: "Save note now",

	// ── Rich-text editor toolbar (richTextEditor.tsx) ─────────────────────────────
	/** Rich editor — placeholder shown in the empty Quill surface */
	noteRichPlaceholder: "Write something…",
	/** Rich editor toolbar — bold toggle */
	noteRichBold: "Bold",
	/** Rich editor toolbar — italic toggle */
	noteRichItalic: "Italic",
	/** Rich editor toolbar — underline toggle */
	noteRichUnderline: "Underline",
	/** Rich editor toolbar — heading cycle (none → H1 → H2 → H3) */
	noteRichHeading: "Heading",
	/** Rich editor toolbar — code block toggle */
	noteRichCode: "Code block",
	/** Rich editor toolbar — blockquote toggle */
	noteRichQuote: "Quote",
	/** Rich editor toolbar — ordered (numbered) list toggle */
	noteRichOrderedList: "Numbered list",
	/** Rich editor toolbar — bulleted list toggle */
	noteRichBulletList: "Bulleted list",
	/** Rich editor toolbar — checklist toggle */
	noteRichCheckList: "Checklist",
	/** Rich editor toolbar — opens the add-link popover */
	noteRichLink: "Add link",
	/** Rich editor toolbar — link URL field label and placeholder */
	noteRichLinkUrl: "Link URL",
	/** Rich editor toolbar — submits the link popover */
	noteRichLinkAdd: "Add",
	/** Rich editor toolbar — removes the link on the selection */
	noteRichUnlink: "Remove link",

	// ── Checklist editor (checklistEditor.tsx) ────────────────────────────────────
	/** Checklist editor — accessible label on a row's checked toggle */
	noteChecklistToggle: "Toggle item",
	/** Checklist editor — accessible label on a row's text field */
	noteChecklistRowInput: "Checklist item",
	/** Checklist editor — placeholder in an empty checklist row */
	noteChecklistItemPlaceholder: "List item",

	// ── Note menu (noteMenu.tsx) ─────────────────────────────────────────────
	/** Note menu trigger — accessible label on the row/header ⋯ button, mirrors driveItemMenuTrigger */
	noteItemMenuTrigger: "More actions",
	/** Note menu — renames the note (opens noteRenameDialog) */
	noteActionRename: "Rename",
	/** Note menu — duplicates the note */
	noteActionDuplicate: "Duplicate",
	/** Note menu — downloads the note as a faithful file (.md/.txt/.html per type) */
	noteActionExport: "Export",
	/** Note menu — copies the note's uuid to the clipboard */
	noteActionCopyId: "Copy ID",
	/** Note menu — copyId's clipboard-write confirmation toast */
	noteCopyIdToast: "Note ID copied to clipboard",
	/** Note menu — copies the note's decrypted content to the clipboard */
	noteActionCopyContent: "Copy content",
	/** Note menu — copyContent's clipboard-write confirmation toast */
	noteCopyContentToast: "Note content copied to clipboard",
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
	/** Note menu — opens the participants dialog (owner only) */
	noteActionParticipants: "Participants",
	/** Note menu — opens the history dialog */
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
	/** Note menu (editor header only) — checklist notes only: filters checked rows out of the render */
	noteActionHideCompletedChecklist: "Hide completed items",

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
	/** Tag row menu — creates a new note, auto-tagged with this tag, and opens it */
	noteTagActionCreateNote: "Create note",
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
	/** Sync outbox — one toast per note per pass when a local edit overwrote newer remote changes (kept in history) */
	noteOverwroteNewerRemoteChanges:
		'"{{name}}" had newer changes on another device. Your version was saved; the previous one is in the note history.',
	/** Editor — coalesced warning that a note edit couldn't be persisted to this device's disk (still pushed when online) */
	noteNotSavedToDevice: "Your changes couldn't be saved to this device",

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
	noteTagDeleteDialogBody: "Notes carrying this tag are not deleted — they only lose the tag. This cannot be undone.",

	// ── Realtime remote-edit banner ──────────────────────────────────────────────
	/** Reload-vs-keep banner — title (the note changed on the server while you have unsaved edits) */
	noteRemoteEditTitle: "Updated elsewhere",
	/** Reload-vs-keep banner — body */
	noteRemoteEditBody: "This note changed on another device.",
	/** Reload-vs-keep banner — take the server version, discarding local edits */
	noteRemoteEditReload: "Reload",
	/** Reload-vs-keep banner — dismiss and keep the local edits */
	noteRemoteEditKeep: "Keep mine",

	// ── Participants dialog ────────────────────────────────────────────────────
	/** Participants dialog — title */
	noteParticipantsDialogTitle: "Participants",
	/** Participants dialog — owner-only "add participants" button, opens the contact-picker sub-view */
	noteParticipantsAddAction: "Add participants",
	/** Participants dialog — badge/label on the owner's own row */
	noteParticipantsOwnerBadge: "Owner",
	/** Participants dialog — accessible label on a row's permission switch; {{email}} = the participant's email */
	noteParticipantsCanEditLabel: "{{email}} can edit",
	/** Participants dialog — accessible label on a row's remove button; {{email}} = the participant's email */
	noteParticipantsRemoveAction: "Remove {{email}}",
	/** Participants dialog — accessible label on a row's block button; {{email}} = the participant's email */
	noteParticipantsBlockAction: "Block {{email}}",
	/** Participants dialog — accessible label on a row's unblock button; {{email}} = the participant's email */
	noteParticipantsUnblockAction: "Unblock {{email}}",
	/** Participants dialog — the blocked-contact record moved (e.g. unblocked in another tab) between render and click */
	noteParticipantBlockStale: "This contact's block status just changed. Please try again.",
	/** Participants dialog — empty state when the note has no participants besides the current user */
	noteParticipantsEmpty: "No other participants yet",
	/** Participants dialog — remove confirm dialog title */
	noteParticipantRemoveDialogTitle: "Remove participant?",
	/** Participants dialog — remove confirm dialog's own submit button (no email, unlike the row's aria-labeled icon button) */
	noteParticipantRemoveDialogConfirm: "Remove",
	/** Participants dialog — remove confirm dialog body; {{email}} = the participant's email */
	noteParticipantRemoveDialogBody: "{{email}} will lose access to this note.",
	/** Participants dialog — load-error title; the body is the failing query's own errorLabel */
	noteParticipantsLoadError: "Couldn't load participants",
	/** Add-participants sub-view — dialog title */
	noteParticipantsAddDialogTitle: "Add participants",
	/** Add-participants sub-view — body above the contact list */
	noteParticipantsAddDialogBody: "Choose one or more contacts to add to this note.",
	/** Add-participants sub-view — submit button */
	noteParticipantsAddSubmit: "Add",
	/** Add-participants sub-view — empty state when every contact is already a participant, or the account has no contacts */
	noteParticipantsAddEmpty: "No contacts available to add",

	// ── History dialog ─────────────────────────────────────────────────────────
	/** History dialog — title */
	noteHistoryDialogTitle: "History",
	/** History dialog — empty state when the note has no recorded versions yet */
	noteHistoryEmpty: "No history yet",
	/** History dialog — load-error title; the body is the failing query's own errorLabel */
	noteHistoryLoadError: "Couldn't load history",
	/** History dialog — fallback subtitle for a version with no preview text */
	noteHistoryNoPreview: "No preview available",
	/** History dialog — a version row's "view" action, opens its read-only preview below the list */
	noteHistoryViewAction: "View",
	/** History dialog — a version row's "restore" action */
	noteHistoryRestoreAction: "Restore",
	/** History dialog — the preview panel's own back-to-list action */
	noteHistoryBackToList: "Back to list",
	/** History dialog — preview panel shown for a version whose content wasn't returned */
	noteHistoryPreviewUnavailable: "Preview unavailable for this version.",
	/** History dialog — restore confirm dialog title */
	noteHistoryRestoreDialogTitle: "Restore this version?",
	/** History dialog — restore confirm dialog body */
	noteHistoryRestoreDialogBody: "The note's current content will be replaced with this version. This cannot be undone.",

	// ── Multi-select + bulk-action bar ──────────────────────────────────────────
	/** Keymap — description for the Cmd/Ctrl+A action that selects every currently-visible note */
	notesCommandSelectAll: "Select all notes",
	/** Keymap — description for the Escape action that clears the notes selection; also the bulk bar's clear button */
	notesCommandClearSelection: "Clear selection",
	/** Bulk-action bar — selection-count label; singular */
	notesSelectionCount_one: "{{count}} selected",
	/** Bulk-action bar — selection-count label; plural */
	notesSelectionCount_other: "{{count}} selected",
	/** Bulk-action bar — every action's outcome toast when every selected note succeeded; singular */
	notesBulkActionComplete_one: "{{count}} note updated",
	/** Bulk-action bar — every action's outcome toast when every selected note succeeded; plural */
	notesBulkActionComplete_other: "{{count}} notes updated",
	/** Bulk-action bar — outcome toast when some selected notes failed; singular */
	notesBulkActionCompleteWithFailures_one: "{{count}} note updated, {{failed}} failed",
	/** Bulk-action bar — outcome toast when some selected notes failed; plural */
	notesBulkActionCompleteWithFailures_other: "{{count}} notes updated, {{failed}} failed",
	/** Bulk trash confirm dialog — title; the confirm button reuses noteActionTrash */
	notesTrashSelectedConfirmTitle: "Move to trash?",
	/** Bulk trash confirm dialog — body; singular */
	notesTrashSelectedConfirmBody_one: "Are you sure you want to move this note to the trash? You can restore it later.",
	/** Bulk trash confirm dialog — body; plural */
	notesTrashSelectedConfirmBody_other: "Are you sure you want to move these {{count}} notes to the trash? You can restore them later.",
	/** Bulk delete-permanently confirm dialog — title; the confirm button reuses noteActionDeletePermanently */
	notesDeleteSelectedConfirmTitle: "Delete permanently?",
	/** Bulk delete-permanently confirm dialog — body; singular */
	notesDeleteSelectedConfirmBody_one: "Are you sure you want to permanently delete this note? This cannot be undone.",
	/** Bulk delete-permanently confirm dialog — body; plural */
	notesDeleteSelectedConfirmBody_other: "Are you sure you want to permanently delete these {{count}} notes? This cannot be undone.",
	/** Bulk leave confirm dialog — title; the confirm button reuses noteActionLeave */
	notesLeaveSelectedConfirmTitle: "Leave notes?",
	/** Bulk leave confirm dialog — body; singular */
	notesLeaveSelectedConfirmBody_one: "Are you sure you want to leave this note? You will lose access to it.",
	/** Bulk leave confirm dialog — body; plural */
	notesLeaveSelectedConfirmBody_other: "Are you sure you want to leave these {{count}} notes? You will lose access to them."
} as const
