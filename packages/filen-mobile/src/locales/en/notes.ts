// Notes feature vocabulary — the notes list/tags views (src/components/notes/**) and the
// note/tag detail routes (src/routes/note/[uuid].tsx, noteHistory, noteParticipants, noteTags).
// Truly-shared keys (cancel, create, delete, trash, restore, archive, pin/unpin,
// favorite/unfavorite, leave, rename, export, participants, history, view, select/deselect,
// select_all/deselect_all, remove, save, add, type, the `selected` plural pair, …) live in
// common.ts and must NOT be redefined here.
//
// NOTE-TYPE KEYS: a note's type is rendered two ways — from a static submenu and from a
// dynamic `Record<typeString, key>` lookup. The five canonical type keys below are the single
// source of truth for both paths. The runtime once produced two divergent labels for the same
// type ("rich"→richtext-dynamic vs "richtext"-static, "md"→markdown-dynamic vs
// "markdown"-static); both now resolve to ONE key (note_type_richtext / note_type_markdown)
// via the map in each call site, so the label is identical regardless of path.
export const notes = {
	// ── List / view titles ────────────────────────────────────────────────────
	/** Notes tab — list header title (the notes list) */
	notes: "Notes",
	/** Notes tab — list header title while showing the tags view */
	tags: "Tags",
	/** Empty-state message shown when the user has no notes */
	no_notes: "No notes",
	/** Empty-state message shown when the user has no tags */
	no_tags: "No tags",
	/** Search bar placeholder while browsing the notes list */
	search_notes: "Search notes",
	/** Search bar placeholder while browsing the tags list */
	search_tags: "Search tags",
	/** Menu action that toggles between the notes view and the tags view */
	view_mode: "View",
	/** View-mode submenu entry: show the flat list of notes */
	notes_view: "Notes",
	/** View-mode submenu entry: show notes grouped by tag */
	tags_view: "Tags",

	// ── Note-type labels (canonical — used by both static and dynamic paths) ──
	/** Note type: plain text */
	note_type_text: "Text",
	/** Note type: checklist (to-do list) */
	note_type_checklist: "Checklist",
	/** Note type: code (syntax-highlighted) */
	note_type_code: "Code",
	/** Note type: Markdown */
	note_type_markdown: "Markdown",
	/** Note type: rich text (formatted) */
	note_type_richtext: "Rich text",

	// ── Create / import notes ─────────────────────────────────────────────────
	/** Menu action: copy the note's text content to the clipboard */
	copy_content: "Copy content",
	/** Menu action / dialog title: create a new note */
	create_note: "Create note",
	/** Input dialog message asking for the new note's name */
	enter_note_name: "Enter a name for the note",
	/** Menu action / dialog title: import a note from a text file */
	import_note: "Import note",
	/** Editor placeholder shown in an empty note body */
	note_editor_placeholder: "Start writing…",
	/** Checklist editor — header menu toggle that hides completed (checked) items from view (client-side only, never edits the note) */
	hide_completed_items: "Hide completed items",
	/** Error toast when the picked file to import could not be found */
	import_file_not_found: "File not found",
	/** Error toast when the picked file to import is missing or empty */
	import_file_not_found_or_empty: "File not found or empty",

	// ── Per-note destructive / state confirmations ────────────────────────────
	/** Confirmation dialog title before trashing a single note */
	trash_note: "Trash note",
	/** Confirmation dialog message before trashing a single note */
	are_you_sure_trash_note: "Are you sure you want to move this note to the trash? You can restore it later.",
	/** Confirmation dialog title before permanently deleting a single note */
	delete_note: "Delete note",
	/** Confirmation dialog message before permanently deleting a single note */
	are_you_sure_delete_note: "Are you sure you want to permanently delete this note? This cannot be undone.",
	/** Confirmation dialog title before leaving a shared note */
	leave_note: "Leave note",
	/** Confirmation dialog message before leaving a shared note */
	are_you_sure_leave_note: "Are you sure you want to leave this note?",
	/** Input dialog title when renaming a note */
	rename_note: "Rename note",
	// enter_new_name lives in common.ts.

	// ── Remote-edit reload prompt (note/content) ──────────────────────────────
	/** Dialog title shown when another participant edited the open note */
	note_edited: "Note edited",
	/** Dialog message shown when another participant edited the open note, offering to reload */
	note_edited_message: "This note was edited by someone else. Reload to see the latest changes? Any unsynced local edits will be lost.",
	/** Confirm button that reloads the note's content from the server */
	reload: "Reload",

	// ── In-flight content sync (note/content + sync) ──────────────────────────
	/** Toast after a queued local edit was synced OVER newer remote changes — the buried version stays in the note's history. {{name}} is the note title */
	note_overwrote_newer_remote_changes: "\"{{name}}\" had newer changes — the previous version is in the note's history",
	/** Error banner when a typed edit could not be persisted to device storage (it survives in memory only until synced) */
	note_edit_not_saved_to_device: "Your edit could not be saved on this device. Keep the app open until it has synced.",

	// ── Bulk note actions (multi-select toolbar) ──────────────────────────────
	/** Bulk action: pin every selected note */
	pin_selected: "Pin selected",
	/** Bulk action: unpin every selected note */
	unpin_selected: "Unpin selected",
	// favorite_selected and unfavorite_selected live in common.ts.
	/** Bulk action: change the type of every selected note */
	type_change_selected: "Change type of selection",
	/** Bulk action: add or remove tags across every selected note */
	bulk_tag_selected: "Tag selection",
	/** Bulk action: duplicate every selected note */
	duplicate_selected: "Duplicate selected",
	/** Bulk action: export every selected note */
	export_selected: "Export selected",
	/** Bulk action: archive every selected note */
	archive_selected: "Archive selected",
	// restore_selected and trash_selected live in common.ts.
	/** Bulk action: leave every selected shared note */
	leave_selected: "Leave selected",
	/** Confirmation dialog message before trashing every selected note */
	are_you_sure_trash_selected_notes: "Are you sure you want to move the selected notes to the trash? You can restore them later.",
	/** Confirmation dialog message before permanently deleting every selected note */
	are_you_sure_delete_selected_notes: "Are you sure you want to permanently delete the selected notes? This cannot be undone.",
	/** Confirmation dialog message before leaving every selected shared note */
	are_you_sure_leave_selected_notes: "Are you sure you want to leave the selected notes?",

	// ── Tags: create / rename / favorite / delete ─────────────────────────────
	/** Menu action / dialog title: create a new tag */
	create_tag: "Create tag",
	/** Input dialog message asking for the new tag's name */
	enter_tag_name: "Enter a name for the tag",
	/** Menu action / dialog title: rename a tag */
	rename_tag: "Rename tag",
	/** Input dialog title asking for a tag's new name */
	new_tag_name: "New tag name",
	/** Confirmation dialog title before deleting a single tag */
	delete_tag: "Delete tag",
	/** Confirmation dialog message before deleting a single tag */
	are_you_sure_delete_tag: "Are you sure you want to delete this tag? It will be removed from all notes.",
	/** Bulk action confirm button: delete every selected tag */
	delete_all_tags: "Delete",
	/** Confirmation dialog title before deleting every selected tag */
	delete_all_tags_title: "Delete tags",
	/** Confirmation dialog message before deleting every selected tag */
	delete_all_tags_confirmation: "Are you sure you want to delete the selected tags? They will be removed from all notes.",
	/** Tag row subtitle (exactly one note): {{count}} is the note count, {{date}} the last-edited date */
	tag_notes_count_and_date_one: "{{count}} note, {{date}}",
	/** Tag row subtitle (plural): {{count}} is the note count, {{date}} the last-edited date */
	tag_notes_count_and_date_other: "{{count}} notes, {{date}}",

	// ── Note tags screen (add/remove tags to one or many notes) ───────────────
	/** Tags screen — error-state message when the tags query fails after retries */
	note_tags_error: "Couldn't load tags",
	/** Tags screen — header title when tagging a single note */
	note_tags: "Tags",
	/** Tags screen — header title when tagging multiple selected notes */
	note_tags_selected: "Tag selected notes",
	/** Tag toggle: remove this tag from the single open note */
	remove_tag: "Remove tag",
	/** Tag toggle: remove this tag from every selected note */
	remove_tag_from_selected: "Remove from selected",
	/** Tag toggle: add this tag to the notes that don't yet carry it */
	add_tag_to_remaining: "Add to remaining",
	/** Tag toggle: add this tag to the single open note */
	add_tag: "Add tag",
	/** Tag toggle: add this tag to every selected note */
	add_tag_to_selected: "Add to selected",

	// ── Note history ──────────────────────────────────────────────────────────
	/** History screen — header title (a note's version history) */
	note_history: "Note history",
	/** History screen — error-state message when the history query fails after retries */
	note_history_error: "Couldn't load history",
	/** History screen — empty-state message when a note has no past versions */
	no_note_history: "No history",
	/** History row — fallback text when a version has no content preview */
	no_preview_history: "No preview",
	/** Confirmation dialog title before restoring the open note to a past version */
	restore_note: "Restore note",
	/** Confirmation dialog message before restoring the open note to a past version */
	are_you_sure_restore_note: "Are you sure you want to restore the note to this version?",
	/** Confirmation dialog title before restoring a selected history version */
	restore_history: "Restore version",
	/** Confirmation dialog message before restoring a selected history version */
	restore_history_confirmation: "Are you sure you want to restore the note to this version?",

	// ── Note participants ─────────────────────────────────────────────────────
	/** Participants screen — header title (a note's collaborators) */
	note_participants: "Participants",
	/** Participants screen — empty-state message when a note has no other participants */
	no_note_participants: "No participants",
	/** Participant menu: open the read/write permission submenu */
	permissions: "Permissions",
	/** Permission option: read-only access */
	permission_read: "Read",
	/** Permission option: read & write access */
	permission_write: "Write",
	// remove_participant and remove_selected live in common.ts.
	/** Confirmation dialog message before removing a single participant from a note */
	remove_participant_confirmation_note: "Are you sure you want to remove this participant from the note?",
	/** Confirmation dialog message before removing every selected participant from a note */
	remove_selected_participants_confirmation_note: "Are you sure you want to remove the selected participants from the note?",

	// ── Empty-state subtitles (ListEmpty descriptions) ────────────────────────
	/** Notes list — empty-state subtitle when no notes exist yet */
	no_notes_description: "Create a note to get started.",
	/** Tags — empty-state subtitle when no tags exist yet */
	no_tags_description: "Create tags to organize your notes.",
	/** Note history — empty-state subtitle when the note has no past versions */
	no_note_history_description: "Edits you make to this note will appear here.",
	/** Note participants — empty-state subtitle when the note has no other participants */
	no_note_participants_description: "Add people to collaborate on this note.",
	/** Tags view — sort submenu group: by most recently edited note in the tag */
	sort_last_activity: "Last activity",
	/** Tags view — sort option: most recently active tags first */
	sort_last_activity_newest: "Last activity (newest)",
	/** Tags view — sort option: least recently active tags first */
	sort_last_activity_oldest: "Last activity (oldest)",
	/** Tags view — sort submenu group: by how many notes carry the tag */
	sort_note_count: "Number of notes",
	/** Tags view — sort option: tags with the most notes first */
	sort_note_count_most: "Most notes",
	/** Tags view — sort option: tags with the fewest notes first */
	sort_note_count_fewest: "Fewest notes"
} as const
