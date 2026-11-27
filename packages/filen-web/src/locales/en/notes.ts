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
	/** Notes sidebar — header ⋯ trigger next to "New note", opens the bulk-ops menu */
	notesSidebarMoreActions: "More options",
	/** Notes sidebar bulk-ops menu — downloads every non-trashed note as one archive */
	notesExportAllAction: "Export all",
	/** Notes sidebar bulk-ops menu — the downloaded archive's own file name */
	notesExportAllFilename: "Notes.zip",
	/** Export — warning after an archive left out notes that couldn't be decrypted; {{count}} = skipped notes; singular */
	notesExportSkippedUndecryptable_one: "{{count}} note couldn't be decrypted and was skipped.",
	/** Export — warning after an archive left out notes that couldn't be decrypted; {{count}} = skipped notes; plural */
	notesExportSkippedUndecryptable_other: "{{count}} notes couldn't be decrypted and were skipped.",
	/** Notes sidebar bulk-ops menu — opens the file picker to import a note from a text/markdown/code/html file */
	notesImportAction: "Import note",
	/** importNoteFromFile — the picked file's extension doesn't match any recognized note type */
	noteImportUnsupportedType: "This file type isn't supported for import.",
	/** importNoteFromFile — the file's text is past the note size cap, so no note is created */
	noteImportTooLarge: "This file is too large to import as a note.",

	// ── View toggle ────────────────────────────────────────────────────────────
	/** Notes sidebar — toggle option showing the flat note list */
	notesViewNotes: "Notes",
	/** Notes sidebar — toggle option showing tags as collapsible groups */
	notesViewTags: "Tags",
	/** Notes sidebar — accessible label for the notes/tags view toggle group */
	notesViewToggleLabel: "Sidebar view",

	// ── Note row affordances ───────────────────────────────────────────────────
	/** Note row — accessible label on the pin toggle (pressed while pinned) */
	notePinned: "Pinned",
	/** Note row — accessible label on the favorite toggle (pressed while favorited) */
	noteFavorite: "Favorite",
	/** Note row — fallback title for a note that has no title yet */
	noteUntitled: "Untitled note",
	/** Note row — shared mark's tooltip on a note shared TO you; {{email}} = the owning participant's email */
	noteSharedByEmail: "Shared by {{email}}",
	/** Note row — shared mark's tooltip; {{names}} = the other participants' names as a list */
	noteSharedWith: "Shared with {{names}}",
	/** Note row — chip standing for the tags not shown; {{hidden}} = how many */
	noteMoreTags: "+{{hidden}}",

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
	/** Notes sidebar — accessible name for the note list itself (ARIA tree of date/tag groups and their notes) */
	notesListLabel: "Notes list",

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
	/** Tags view — label of the pinned bottom row grouping every note that carries no tag */
	notesTagUntagged: "Untagged",

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
	/** Either view — shown instead of notesSearchEmptyTitle while note contents are still being read for the search */
	notesSearchingBodies: "Searching notes…",
	/** Either view — body under notesSearchEmptyTitle when some note contents could not be read (failed or offline), so they were not searched; {{count}} = unsearched notes; singular */
	notesSearchUnsearchedBodies_one: "{{count}} note couldn't be searched.",
	/** Either view — body under notesSearchEmptyTitle when some note contents could not be read (failed or offline), so they were not searched; {{count}} = unsearched notes; plural */
	notesSearchUnsearchedBodies_other: "{{count}} notes couldn't be searched.",
	/** Sidebar — title shown when the notes list fails to load; the body is the failing query's own errorLabel */
	notesLoadError: "Couldn't load notes",

	// ── Editor placeholder card ────────────────────────────────────────────────
	/** Editor card — centered prompt when no note is selected */
	notesSelectPrompt: "Select a note",
	/** Editor card — body under notesSelectPrompt */
	notesSelectPromptDescription: "Choose a note from the list, or create a new one.",
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
	/** Editor header — status in place of the sync spinner while the note's last save failed and waits to be sent again */
	noteSaveFailedRetrying: "Not saved — retrying",
	/** Editor header — button next to noteSaveFailedRetrying that sends the failed save again right away */
	noteSaveRetryNow: "Retry now",
	/** Sync outbox — error toast when a note's save kept being rejected and was given up; the editor still shows the text */
	noteSaveGaveUp: '"{{name}}" couldn\'t be saved, and saving was stopped. Copy your latest changes before leaving the note.',
	/** Editor header — chip on a shared note this user may read but not edit */
	noteViewOnly: "View only",
	/** Export / copy content — the note's content exists but its ciphertext couldn't be decrypted */
	noteContentUndecryptableError: "This note's content couldn't be decrypted.",
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
	/** Note menu and the note header's participants button (its tooltip and accessible name) — opens or closes the participants panel */
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

	// ── Changes made elsewhere ───────────────────────────────────────────────────
	/** Remote-change dialog — title, shown while this note is being edited and a newer version of it is saved elsewhere (another device, another tab, or another participant) */
	noteRemoteEditTitle: "This note changed elsewhere",
	/** Remote-change dialog — body */
	noteRemoteEditBody: "A newer version of this note was saved while you were editing it. What should happen to your changes?",
	/** Title of the note the local changes are written to by the remote-change dialog's "Save mine as copy"; {{title}} is the note's title, {{date}} the current date and time */
	noteRemoteEditCopyTitle: "{{title}} (conflicted copy {{date}})",
	/** Toast after the local changes were written to a new note; {{title}} is its title */
	noteRemoteEditSavedAsCopy: 'Saved your changes as "{{title}}".',
	/** Toast when the open note, with no local changes, now shows a newer version saved elsewhere */
	noteUpdatedElsewhere: "Updated with changes saved elsewhere.",

	// ── Participants panel ─────────────────────────────────────────────────────
	/** Participants panel — heading; {{number}} = how many people are on the note, the viewer included */
	noteParticipantsPanelTitle: "Participants ({{number}})",
	/** Participants panel — one muted line under the heading */
	noteParticipantsPanelDescription: "People who can open this note",
	/** Participants panel — the viewer's own row; {{name}} = their display name */
	noteParticipantSelf: "{{name}} (you)",
	/** Participants panel — permission option and read-only label: the participant may edit the note */
	noteParticipantCanEdit: "Can edit",
	/** Participants panel — permission option and read-only label: the participant may only read the note */
	noteParticipantCanView: "Can view",
	/** Participants panel — accessible label on a row's permission select; {{name}} = the participant's display name */
	noteParticipantPermissionLabel: "Permission for {{name}}",
	/** Participants panel — tooltip and accessible label on a row's remove button; {{name}} = the participant's display name */
	noteParticipantRemoveAction: "Remove {{name}}",
	/** Participants panel — tooltip and accessible label on a row's block button; {{name}} = the participant's display name */
	noteParticipantBlockAction: "Block {{name}}",
	/** Participants panel — tooltip and accessible label on a row's unblock button; {{name}} = the participant's display name */
	noteParticipantUnblockAction: "Unblock {{name}}",
	/** Participants panel — remove confirm dialog body; {{email}} = the participant's email */
	noteParticipantRemoveDialogBody: "{{email}} will lose access to this note.",
	/** Add-participants sub-view — body above the contact list */
	noteParticipantsAddDialogBody: "Choose one or more contacts to add to this note.",

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
	noteHistoryRestoreDialogBody:
		"The note's current content will be replaced with this version. It stays in the history, so you can restore it again.",

	// ── Multi-select + bulk-action bar ──────────────────────────────────────────
	/** Keymap — description for the Cmd/Ctrl+A action that selects every currently-visible note */
	notesCommandSelectAll: "Select all notes",
	/** Keymap — description for the Delete/Backspace action that bulk-trashes the selected notes */
	notesCommandTrash: "Move notes to trash",
	/** Keymap — description for the action that renames the note focused in the list, or the note on screen */
	notesCommandRename: "Rename note",
	/** Keymap — description for the action that duplicates the note focused in the list, or the note on screen */
	notesCommandDuplicate: "Duplicate note",
	/** Keymap — description for the action that permanently deletes the selected notes, or the focused or open note, when in the trash */
	notesCommandDeletePermanently: "Delete notes permanently",
	/** Keymap — description for the action that restores a note from the trash or the archive */
	notesCommandRestore: "Restore note",
	/** Keymap — description for the action that archives the note focused in the list */
	notesCommandArchive: "Archive note",
	/** Keymap — description for the action that pins or unpins the note focused in the list */
	notesCommandPin: "Pin or unpin note",
	/** Keymap — description for the action that adds the focused note to favorites or removes it */
	notesCommandFavorite: "Favorite or unfavorite note",
	/** Keymap — description for the action that moves focus to the notes sidebar's search field */
	notesCommandSearch: "Search notes",
	/** Keymap — description for the action that opens the file picker to import a note */
	notesCommandImport: "Import note",
	/** Keymap — description for the action that opens the new-tag dialog */
	notesCommandNewTag: "New tag",
	/** Keymap — description for the action that exports the focused or open note to a file */
	notesCommandExport: "Export note",
	/** Keymap — description for the action that opens the focused or open note's version history */
	notesCommandHistory: "Show note history",
	/** Keymap — description for the action that opens or closes the focused or open note's participants panel */
	notesCommandParticipants: "Manage note participants",
	/** Keymap — description for the action that exports every note as a zip */
	notesCommandExportAll: "Export all notes",
	/** Keymap — description for the action that switches the notes sidebar between its notes and tags views */
	notesCommandToggleView: "Switch between notes and tags",
	/** Keymap — where a notes shortcut works: only while a note's row in the sidebar list has keyboard focus */
	notesHintFocusedRow: "With a note focused in the list",
	/** Bulk delete-permanently confirm dialog — title; the confirm button reuses noteActionDeletePermanently */
	notesDeleteSelectedConfirmTitle: "Delete permanently?",
	/** Bulk delete-permanently confirm dialog — body; singular */
	notesDeleteSelectedConfirmBodySingle: "Are you sure you want to permanently delete this note? This cannot be undone.",
	/** Bulk delete-permanently confirm dialog — body; plural */
	notesDeleteSelectedConfirmBody_one: "Are you sure you want to permanently delete {{count}} note? This cannot be undone.",
	/** Bulk delete-permanently confirm dialog — body; plural */
	notesDeleteSelectedConfirmBody_other: "Are you sure you want to permanently delete these {{count}} notes? This cannot be undone.",
	/** Bulk leave confirm dialog — title; the confirm button reuses noteActionLeave */
	notesLeaveSelectedConfirmTitle: "Leave notes?",
	/** Bulk leave confirm dialog — body; singular */
	notesLeaveSelectedConfirmBodySingle: "Are you sure you want to leave this note? You will lose access to it.",
	/** Bulk leave confirm dialog — body; plural */
	notesLeaveSelectedConfirmBody_one: "Are you sure you want to leave {{count}} note? You will lose access to it.",
	/** Bulk leave confirm dialog — body; plural */
	notesLeaveSelectedConfirmBody_other: "Are you sure you want to leave these {{count}} notes? You will lose access to them.",
	// ── Activity toasts (lib/activity) ──────────────────────────────────────
	// The running line of an action and how it ended, in the toast that shows it. `Named` names the one
	// note ({{name}}, its title), `_other` counts them; a partial result counts the ones that succeeded.
	/** Activity toast — creating a note running; it opens once created, so success shows nothing */
	notesCreating: "Creating a note",
	/** Activity toast — creating a note failed; the error follows under it */
	notesCreateError: "Couldn't create a note",
	/** Activity toast — importing a file as a note running; {{name}} = the file name */
	notesImporting: "Importing {{name}}",
	/** Activity toast — importing a file as a note failed; {{name}} = the file name; the error follows under it */
	notesImportError: "Couldn't import {{name}}",
	/** Activity toast — pinning running; one note named ({{name}}) */
	notesPinRunningNamed: "Pinning {{name}}",
	/** Activity toast — pinning running; {{count}} notes */
	notesPinRunning_one: "Pinning {{count}} note",
	/** Activity toast — pinning running; {{count}} notes */
	notesPinRunning_other: "Pinning {{count}} notes",
	/** Activity toast — pinning finished; one note named ({{name}}) */
	notesPinDoneNamed: "Pinned {{name}}",
	/** Activity toast — pinning finished; {{count}} notes */
	notesPinDone_one: "Pinned {{count}} note",
	/** Activity toast — pinning finished; {{count}} notes */
	notesPinDone_other: "Pinned {{count}} notes",
	/** Activity toast — pinning failed for every note; one note named ({{name}}) */
	notesPinFailedNamed: "Couldn't pin {{name}}",
	/** Activity toast — pinning failed for every note; {{count}} notes */
	notesPinFailed_one: "Couldn't pin {{count}} note",
	/** Activity toast — pinning failed for every note; {{count}} notes */
	notesPinFailed_other: "Couldn't pin {{count}} notes",
	/** Activity toast — pinning partly failed; {{count}} succeeded, {{failed}} failed */
	notesPinPartial_one: "Pinned {{count}} note, {{failed}} failed",
	/** Activity toast — pinning partly failed; {{count}} succeeded, {{failed}} failed */
	notesPinPartial_other: "Pinned {{count}} notes, {{failed}} failed",
	/** Activity toast — unpinning running; one note named ({{name}}) */
	notesUnpinRunningNamed: "Unpinning {{name}}",
	/** Activity toast — unpinning running; {{count}} notes */
	notesUnpinRunning_one: "Unpinning {{count}} note",
	/** Activity toast — unpinning running; {{count}} notes */
	notesUnpinRunning_other: "Unpinning {{count}} notes",
	/** Activity toast — unpinning finished; one note named ({{name}}) */
	notesUnpinDoneNamed: "Unpinned {{name}}",
	/** Activity toast — unpinning finished; {{count}} notes */
	notesUnpinDone_one: "Unpinned {{count}} note",
	/** Activity toast — unpinning finished; {{count}} notes */
	notesUnpinDone_other: "Unpinned {{count}} notes",
	/** Activity toast — unpinning failed for every note; one note named ({{name}}) */
	notesUnpinFailedNamed: "Couldn't unpin {{name}}",
	/** Activity toast — unpinning failed for every note; {{count}} notes */
	notesUnpinFailed_one: "Couldn't unpin {{count}} note",
	/** Activity toast — unpinning failed for every note; {{count}} notes */
	notesUnpinFailed_other: "Couldn't unpin {{count}} notes",
	/** Activity toast — unpinning partly failed; {{count}} succeeded, {{failed}} failed */
	notesUnpinPartial_one: "Unpinned {{count}} note, {{failed}} failed",
	/** Activity toast — unpinning partly failed; {{count}} succeeded, {{failed}} failed */
	notesUnpinPartial_other: "Unpinned {{count}} notes, {{failed}} failed",
	/** Activity toast — adding to favorites running; one note named ({{name}}); also a tag's favorite toggle, naming the tag */
	notesFavoriteRunningNamed: "Adding {{name}} to favorites",
	/** Activity toast — adding to favorites running; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesFavoriteRunning_one: "Adding {{count}} note to favorites",
	/** Activity toast — adding to favorites running; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesFavoriteRunning_other: "Adding {{count}} notes to favorites",
	/** Activity toast — adding to favorites finished; one note named ({{name}}); also a tag's favorite toggle, naming the tag */
	notesFavoriteDoneNamed: "Added {{name}} to favorites",
	/** Activity toast — adding to favorites finished; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesFavoriteDone_one: "Added {{count}} note to favorites",
	/** Activity toast — adding to favorites finished; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesFavoriteDone_other: "Added {{count}} notes to favorites",
	/** Activity toast — adding to favorites failed for every note; one note named ({{name}}); also a tag's favorite toggle, naming the tag */
	notesFavoriteFailedNamed: "Couldn't add {{name}} to favorites",
	/** Activity toast — adding to favorites failed for every note; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesFavoriteFailed_one: "Couldn't add {{count}} note to favorites",
	/** Activity toast — adding to favorites failed for every note; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesFavoriteFailed_other: "Couldn't add {{count}} notes to favorites",
	/** Activity toast — adding to favorites partly failed; {{count}} succeeded, {{failed}} failed; also a tag's favorite toggle, naming the tag */
	notesFavoritePartial_one: "Added {{count}} note to favorites, {{failed}} failed",
	/** Activity toast — adding to favorites partly failed; {{count}} succeeded, {{failed}} failed; also a tag's favorite toggle, naming the tag */
	notesFavoritePartial_other: "Added {{count}} notes to favorites, {{failed}} failed",
	/** Activity toast — removing from favorites running; one note named ({{name}}); also a tag's favorite toggle, naming the tag */
	notesUnfavoriteRunningNamed: "Removing {{name}} from favorites",
	/** Activity toast — removing from favorites running; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesUnfavoriteRunning_one: "Removing {{count}} note from favorites",
	/** Activity toast — removing from favorites running; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesUnfavoriteRunning_other: "Removing {{count}} notes from favorites",
	/** Activity toast — removing from favorites finished; one note named ({{name}}); also a tag's favorite toggle, naming the tag */
	notesUnfavoriteDoneNamed: "Removed {{name}} from favorites",
	/** Activity toast — removing from favorites finished; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesUnfavoriteDone_one: "Removed {{count}} note from favorites",
	/** Activity toast — removing from favorites finished; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesUnfavoriteDone_other: "Removed {{count}} notes from favorites",
	/** Activity toast — removing from favorites failed for every note; one note named ({{name}}); also a tag's favorite toggle, naming the tag */
	notesUnfavoriteFailedNamed: "Couldn't remove {{name}} from favorites",
	/** Activity toast — removing from favorites failed for every note; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesUnfavoriteFailed_one: "Couldn't remove {{count}} note from favorites",
	/** Activity toast — removing from favorites failed for every note; {{count}} notes; also a tag's favorite toggle, naming the tag */
	notesUnfavoriteFailed_other: "Couldn't remove {{count}} notes from favorites",
	/** Activity toast — removing from favorites partly failed; {{count}} succeeded, {{failed}} failed; also a tag's favorite toggle, naming the tag */
	notesUnfavoritePartial_one: "Removed {{count}} note from favorites, {{failed}} failed",
	/** Activity toast — removing from favorites partly failed; {{count}} succeeded, {{failed}} failed; also a tag's favorite toggle, naming the tag */
	notesUnfavoritePartial_other: "Removed {{count}} notes from favorites, {{failed}} failed",
	/** Activity toast — duplicating running; one note named ({{name}}) */
	notesDuplicateRunningNamed: "Duplicating {{name}}",
	/** Activity toast — duplicating running; {{count}} notes */
	notesDuplicateRunning_one: "Duplicating {{count}} note",
	/** Activity toast — duplicating running; {{count}} notes */
	notesDuplicateRunning_other: "Duplicating {{count}} notes",
	/** Activity toast — duplicating finished; one note named ({{name}}) */
	notesDuplicateDoneNamed: "Duplicated {{name}}",
	/** Activity toast — duplicating finished; {{count}} notes */
	notesDuplicateDone_one: "Duplicated {{count}} note",
	/** Activity toast — duplicating finished; {{count}} notes */
	notesDuplicateDone_other: "Duplicated {{count}} notes",
	/** Activity toast — duplicating failed for every note; one note named ({{name}}) */
	notesDuplicateFailedNamed: "Couldn't duplicate {{name}}",
	/** Activity toast — duplicating failed for every note; {{count}} notes */
	notesDuplicateFailed_one: "Couldn't duplicate {{count}} note",
	/** Activity toast — duplicating failed for every note; {{count}} notes */
	notesDuplicateFailed_other: "Couldn't duplicate {{count}} notes",
	/** Activity toast — duplicating partly failed; {{count}} succeeded, {{failed}} failed */
	notesDuplicatePartial_one: "Duplicated {{count}} note, {{failed}} failed",
	/** Activity toast — duplicating partly failed; {{count}} succeeded, {{failed}} failed */
	notesDuplicatePartial_other: "Duplicated {{count}} notes, {{failed}} failed",
	/** Activity toast — changing the type running; one note named ({{name}}); {{type}} = the new type's label */
	notesChangeTypeRunningNamed: "Changing {{name}} to {{type}}",
	/** Activity toast — changing the type running; {{count}} notes; {{type}} = the new type's label */
	notesChangeTypeRunning_one: "Changing {{count}} note to {{type}}",
	/** Activity toast — changing the type running; {{count}} notes; {{type}} = the new type's label */
	notesChangeTypeRunning_other: "Changing {{count}} notes to {{type}}",
	/** Activity toast — changing the type finished; one note named ({{name}}); {{type}} = the new type's label */
	notesChangeTypeDoneNamed: "Changed {{name}} to {{type}}",
	/** Activity toast — changing the type finished; {{count}} notes; {{type}} = the new type's label */
	notesChangeTypeDone_one: "Changed {{count}} note to {{type}}",
	/** Activity toast — changing the type finished; {{count}} notes; {{type}} = the new type's label */
	notesChangeTypeDone_other: "Changed {{count}} notes to {{type}}",
	/** Activity toast — changing the type failed for every note; one note named ({{name}}); {{type}} = the new type's label */
	notesChangeTypeFailedNamed: "Couldn't change {{name}} to {{type}}",
	/** Activity toast — changing the type failed for every note; {{count}} notes; {{type}} = the new type's label */
	notesChangeTypeFailed_one: "Couldn't change {{count}} note to {{type}}",
	/** Activity toast — changing the type failed for every note; {{count}} notes; {{type}} = the new type's label */
	notesChangeTypeFailed_other: "Couldn't change {{count}} notes to {{type}}",
	/** Activity toast — changing the type partly failed; {{count}} succeeded, {{failed}} failed; {{type}} = the new type's label */
	notesChangeTypePartial_one: "Changed {{count}} note to {{type}}, {{failed}} failed",
	/** Activity toast — changing the type partly failed; {{count}} succeeded, {{failed}} failed; {{type}} = the new type's label */
	notesChangeTypePartial_other: "Changed {{count}} notes to {{type}}, {{failed}} failed",
	/** Activity toast — adding a tag running; one note named ({{name}}); {{tag}} = the tag's name */
	notesTagRunningNamed: "Tagging {{name}} with {{tag}}",
	/** Activity toast — adding a tag running; {{count}} notes; {{tag}} = the tag's name */
	notesTagRunning_one: "Tagging {{count}} note with {{tag}}",
	/** Activity toast — adding a tag running; {{count}} notes; {{tag}} = the tag's name */
	notesTagRunning_other: "Tagging {{count}} notes with {{tag}}",
	/** Activity toast — adding a tag finished; one note named ({{name}}); {{tag}} = the tag's name */
	notesTagDoneNamed: "Tagged {{name}} with {{tag}}",
	/** Activity toast — adding a tag finished; {{count}} notes; {{tag}} = the tag's name */
	notesTagDone_one: "Tagged {{count}} note with {{tag}}",
	/** Activity toast — adding a tag finished; {{count}} notes; {{tag}} = the tag's name */
	notesTagDone_other: "Tagged {{count}} notes with {{tag}}",
	/** Activity toast — adding a tag failed for every note; one note named ({{name}}); {{tag}} = the tag's name */
	notesTagFailedNamed: "Couldn't tag {{name}} with {{tag}}",
	/** Activity toast — adding a tag failed for every note; {{count}} notes; {{tag}} = the tag's name */
	notesTagFailed_one: "Couldn't tag {{count}} note with {{tag}}",
	/** Activity toast — adding a tag failed for every note; {{count}} notes; {{tag}} = the tag's name */
	notesTagFailed_other: "Couldn't tag {{count}} notes with {{tag}}",
	/** Activity toast — adding a tag partly failed; {{count}} succeeded, {{failed}} failed; {{tag}} = the tag's name */
	notesTagPartial_one: "Tagged {{count}} note with {{tag}}, {{failed}} failed",
	/** Activity toast — adding a tag partly failed; {{count}} succeeded, {{failed}} failed; {{tag}} = the tag's name */
	notesTagPartial_other: "Tagged {{count}} notes with {{tag}}, {{failed}} failed",
	/** Activity toast — removing a tag running; one note named ({{name}}); {{tag}} = the tag's name */
	notesUntagRunningNamed: "Removing {{tag}} from {{name}}",
	/** Activity toast — removing a tag running; {{count}} notes; {{tag}} = the tag's name */
	notesUntagRunning_one: "Removing {{tag}} from {{count}} note",
	/** Activity toast — removing a tag running; {{count}} notes; {{tag}} = the tag's name */
	notesUntagRunning_other: "Removing {{tag}} from {{count}} notes",
	/** Activity toast — removing a tag finished; one note named ({{name}}); {{tag}} = the tag's name */
	notesUntagDoneNamed: "Removed {{tag}} from {{name}}",
	/** Activity toast — removing a tag finished; {{count}} notes; {{tag}} = the tag's name */
	notesUntagDone_one: "Removed {{tag}} from {{count}} note",
	/** Activity toast — removing a tag finished; {{count}} notes; {{tag}} = the tag's name */
	notesUntagDone_other: "Removed {{tag}} from {{count}} notes",
	/** Activity toast — removing a tag failed for every note; one note named ({{name}}); {{tag}} = the tag's name */
	notesUntagFailedNamed: "Couldn't remove {{tag}} from {{name}}",
	/** Activity toast — removing a tag failed for every note; {{count}} notes; {{tag}} = the tag's name */
	notesUntagFailed_one: "Couldn't remove {{tag}} from {{count}} note",
	/** Activity toast — removing a tag failed for every note; {{count}} notes; {{tag}} = the tag's name */
	notesUntagFailed_other: "Couldn't remove {{tag}} from {{count}} notes",
	/** Activity toast — removing a tag partly failed; {{count}} succeeded, {{failed}} failed; {{tag}} = the tag's name */
	notesUntagPartial_one: "Removed {{tag}} from {{count}} note, {{failed}} failed",
	/** Activity toast — removing a tag partly failed; {{count}} succeeded, {{failed}} failed; {{tag}} = the tag's name */
	notesUntagPartial_other: "Removed {{tag}} from {{count}} notes, {{failed}} failed",
	/** Activity toast — archiving running; one note named ({{name}}) */
	notesArchiveRunningNamed: "Archiving {{name}}",
	/** Activity toast — archiving running; {{count}} notes */
	notesArchiveRunning_one: "Archiving {{count}} note",
	/** Activity toast — archiving running; {{count}} notes */
	notesArchiveRunning_other: "Archiving {{count}} notes",
	/** Activity toast — archiving finished; one note named ({{name}}) */
	notesArchiveDoneNamed: "Archived {{name}}",
	/** Activity toast — archiving finished; {{count}} notes */
	notesArchiveDone_one: "Archived {{count}} note",
	/** Activity toast — archiving finished; {{count}} notes */
	notesArchiveDone_other: "Archived {{count}} notes",
	/** Activity toast — archiving failed for every note; one note named ({{name}}) */
	notesArchiveFailedNamed: "Couldn't archive {{name}}",
	/** Activity toast — archiving failed for every note; {{count}} notes */
	notesArchiveFailed_one: "Couldn't archive {{count}} note",
	/** Activity toast — archiving failed for every note; {{count}} notes */
	notesArchiveFailed_other: "Couldn't archive {{count}} notes",
	/** Activity toast — archiving partly failed; {{count}} succeeded, {{failed}} failed */
	notesArchivePartial_one: "Archived {{count}} note, {{failed}} failed",
	/** Activity toast — archiving partly failed; {{count}} succeeded, {{failed}} failed */
	notesArchivePartial_other: "Archived {{count}} notes, {{failed}} failed",
	/** Activity toast — restoring from archive or trash running; one note named ({{name}}) */
	notesRestoreRunningNamed: "Restoring {{name}}",
	/** Activity toast — restoring from archive or trash running; {{count}} notes */
	notesRestoreRunning_one: "Restoring {{count}} note",
	/** Activity toast — restoring from archive or trash running; {{count}} notes */
	notesRestoreRunning_other: "Restoring {{count}} notes",
	/** Activity toast — restoring from archive or trash finished; one note named ({{name}}) */
	notesRestoreDoneNamed: "Restored {{name}}",
	/** Activity toast — restoring from archive or trash finished; {{count}} notes */
	notesRestoreDone_one: "Restored {{count}} note",
	/** Activity toast — restoring from archive or trash finished; {{count}} notes */
	notesRestoreDone_other: "Restored {{count}} notes",
	/** Activity toast — restoring from archive or trash failed for every note; one note named ({{name}}) */
	notesRestoreFailedNamed: "Couldn't restore {{name}}",
	/** Activity toast — restoring from archive or trash failed for every note; {{count}} notes */
	notesRestoreFailed_one: "Couldn't restore {{count}} note",
	/** Activity toast — restoring from archive or trash failed for every note; {{count}} notes */
	notesRestoreFailed_other: "Couldn't restore {{count}} notes",
	/** Activity toast — restoring from archive or trash partly failed; {{count}} succeeded, {{failed}} failed */
	notesRestorePartial_one: "Restored {{count}} note, {{failed}} failed",
	/** Activity toast — restoring from archive or trash partly failed; {{count}} succeeded, {{failed}} failed */
	notesRestorePartial_other: "Restored {{count}} notes, {{failed}} failed",
	/** Activity toast — moving to trash running; one note named ({{name}}) */
	notesTrashRunningNamed: "Moving {{name}} to trash",
	/** Activity toast — moving to trash running; {{count}} notes */
	notesTrashRunning_one: "Moving {{count}} note to trash",
	/** Activity toast — moving to trash running; {{count}} notes */
	notesTrashRunning_other: "Moving {{count}} notes to trash",
	/** Activity toast — moving to trash finished; one note named ({{name}}) */
	notesTrashDoneNamed: "Moved {{name}} to trash",
	/** Activity toast — moving to trash finished; {{count}} notes */
	notesTrashDone_one: "Moved {{count}} note to trash",
	/** Activity toast — moving to trash finished; {{count}} notes */
	notesTrashDone_other: "Moved {{count}} notes to trash",
	/** Activity toast — moving to trash failed for every note; one note named ({{name}}) */
	notesTrashFailedNamed: "Couldn't move {{name}} to trash",
	/** Activity toast — moving to trash failed for every note; {{count}} notes */
	notesTrashFailed_one: "Couldn't move {{count}} note to trash",
	/** Activity toast — moving to trash failed for every note; {{count}} notes */
	notesTrashFailed_other: "Couldn't move {{count}} notes to trash",
	/** Activity toast — moving to trash partly failed; {{count}} succeeded, {{failed}} failed */
	notesTrashPartial_one: "Moved {{count}} note to trash, {{failed}} failed",
	/** Activity toast — moving to trash partly failed; {{count}} succeeded, {{failed}} failed */
	notesTrashPartial_other: "Moved {{count}} notes to trash, {{failed}} failed",
	/** Activity toast — deleting permanently running; one note named ({{name}}) */
	notesDeletePermanentlyRunningNamed: "Deleting {{name}}",
	/** Activity toast — deleting permanently running; {{count}} notes */
	notesDeletePermanentlyRunning_one: "Deleting {{count}} note",
	/** Activity toast — deleting permanently running; {{count}} notes */
	notesDeletePermanentlyRunning_other: "Deleting {{count}} notes",
	/** Activity toast — deleting permanently finished; one note named ({{name}}) */
	notesDeletePermanentlyDoneNamed: "Deleted {{name}}",
	/** Activity toast — deleting permanently finished; {{count}} notes */
	notesDeletePermanentlyDone_one: "Deleted {{count}} note",
	/** Activity toast — deleting permanently finished; {{count}} notes */
	notesDeletePermanentlyDone_other: "Deleted {{count}} notes",
	/** Activity toast — deleting permanently failed for every note; one note named ({{name}}) */
	notesDeletePermanentlyFailedNamed: "Couldn't delete {{name}}",
	/** Activity toast — deleting permanently failed for every note; {{count}} notes */
	notesDeletePermanentlyFailed_one: "Couldn't delete {{count}} note",
	/** Activity toast — deleting permanently failed for every note; {{count}} notes */
	notesDeletePermanentlyFailed_other: "Couldn't delete {{count}} notes",
	/** Activity toast — deleting permanently partly failed; {{count}} succeeded, {{failed}} failed */
	notesDeletePermanentlyPartial_one: "Deleted {{count}} note, {{failed}} failed",
	/** Activity toast — deleting permanently partly failed; {{count}} succeeded, {{failed}} failed */
	notesDeletePermanentlyPartial_other: "Deleted {{count}} notes, {{failed}} failed",
	/** Activity toast — leaving shared notes running; one note named ({{name}}) */
	notesLeaveRunningNamed: "Leaving {{name}}",
	/** Activity toast — leaving shared notes running; {{count}} notes */
	notesLeaveRunning_one: "Leaving {{count}} note",
	/** Activity toast — leaving shared notes running; {{count}} notes */
	notesLeaveRunning_other: "Leaving {{count}} notes",
	/** Activity toast — leaving shared notes finished; one note named ({{name}}) */
	notesLeaveDoneNamed: "Left {{name}}",
	/** Activity toast — leaving shared notes finished; {{count}} notes */
	notesLeaveDone_one: "Left {{count}} note",
	/** Activity toast — leaving shared notes finished; {{count}} notes */
	notesLeaveDone_other: "Left {{count}} notes",
	/** Activity toast — leaving shared notes failed for every note; one note named ({{name}}) */
	notesLeaveFailedNamed: "Couldn't leave {{name}}",
	/** Activity toast — leaving shared notes failed for every note; {{count}} notes */
	notesLeaveFailed_one: "Couldn't leave {{count}} note",
	/** Activity toast — leaving shared notes failed for every note; {{count}} notes */
	notesLeaveFailed_other: "Couldn't leave {{count}} notes",
	/** Activity toast — leaving shared notes partly failed; {{count}} succeeded, {{failed}} failed */
	notesLeavePartial_one: "Left {{count}} note, {{failed}} failed",
	/** Activity toast — leaving shared notes partly failed; {{count}} succeeded, {{failed}} failed */
	notesLeavePartial_other: "Left {{count}} notes, {{failed}} failed"
} as const
