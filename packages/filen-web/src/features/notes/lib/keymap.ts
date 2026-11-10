import type { ActionDef } from "@/lib/keymap/registry"

// The notes surface's commands. Combos deliberately mirror drive's ("n" for new, mod+a/escape for
// selection, delete/backspace for bulk trash): the two never coexist, since they live on mutually
// exclusive routes. Both selection commands fire through react-hotkeys-hook's default ignore-list,
// which skips real form-tag targets, so neither fights the sidebar search box's own Escape handling.
//
// `notes.saveNow` flushes the outbox debounce immediately; its handler passes
// `enableOnContentEditable` because CodeMirror's content DOM sets contenteditable while editable,
// and without it Cmd/Ctrl+S would never fire with the cursor in the editor — exactly when a user
// presses it.
export const NOTES_ACTIONS: readonly ActionDef[] = [
	{ id: "notes.newNote", defaultCombo: "n", scope: "notes", descriptionKey: "notes:notesNewNote" },
	{ id: "notes.selectAll", defaultCombo: "mod+a", scope: "notes", descriptionKey: "notes:notesCommandSelectAll" },
	{ id: "notes.clearSelection", defaultCombo: "escape", scope: "notes", descriptionKey: "common:clearSelection" },
	{
		id: "notes.trash",
		defaultCombo: "delete,backspace",
		// Finder's Move to Trash.
		platformDefaults: [{ on: { mac: true }, combo: "delete,backspace,mod+backspace" }],
		scope: "notes",
		descriptionKey: "notes:notesCommandTrash"
	},
	{ id: "notes.saveNow", defaultCombo: "mod+s", scope: "notes", descriptionKey: "notes:notesSaveAction" },
	// The note acted on: the one whose row has focus in the list, else the note on screen.
	{ id: "notes.rename", defaultCombo: "f2", scope: "notes", descriptionKey: "notes:notesCommandRename" },
	{ id: "notes.duplicate", defaultCombo: "mod+shift+d", scope: "notes", descriptionKey: "notes:notesCommandDuplicate" },
	// The selection's notes when it permits it, else the focused or open note, if it is in the trash.
	{
		id: "notes.deletePermanently",
		defaultCombo: "shift+delete",
		// Finder's Delete Immediately; a Mac keyboard often has no Delete key.
		platformDefaults: [{ on: { mac: true }, combo: "shift+delete,mod+alt+backspace" }],
		scope: "notes",
		descriptionKey: "notes:notesCommandDeletePermanently"
	},
	// Out of the trash or the archive. Unassigned: no key reads as "restore" in the apps users know.
	{ id: "notes.restore", defaultCombo: "", scope: "notes", descriptionKey: "notes:notesCommandRestore" },
	// Single keys on the focused row only (Gmail's archive, pin and star keys), never on the page at large.
	{
		id: "notes.archive",
		defaultCombo: "e",
		scope: "notes",
		descriptionKey: "notes:notesCommandArchive",
		hintKey: "notes:notesHintFocusedRow"
	},
	{
		id: "notes.pin",
		defaultCombo: "p",
		scope: "notes",
		descriptionKey: "notes:notesCommandPin",
		hintKey: "notes:notesHintFocusedRow"
	},
	{
		id: "notes.favorite",
		defaultCombo: "f",
		scope: "notes",
		descriptionKey: "notes:notesCommandFavorite",
		hintKey: "notes:notesHintFocusedRow"
	},
	// Focuses the sidebar's filter, outside the editors (which keep Mod+F for their own find).
	{ id: "notes.search", defaultCombo: "mod+f", scope: "notes", descriptionKey: "notes:notesCommandSearch" },
	{ id: "notes.import", defaultCombo: "mod+o", scope: "notes", descriptionKey: "notes:notesCommandImport" },
	{ id: "notes.newTag", defaultCombo: "shift+n", scope: "notes", descriptionKey: "notes:notesCommandNewTag" },
	// Unassigned: rarer than the above, and every free chord near them is a browser's or an editor's.
	{ id: "notes.export", defaultCombo: "", scope: "notes", descriptionKey: "notes:notesCommandExport" },
	{ id: "notes.history", defaultCombo: "", scope: "notes", descriptionKey: "notes:notesCommandHistory" },
	{ id: "notes.participants", defaultCombo: "", scope: "notes", descriptionKey: "notes:notesCommandParticipants" },
	{ id: "notes.exportAll", defaultCombo: "", scope: "notes", descriptionKey: "notes:notesCommandExportAll" },
	{ id: "notes.toggleView", defaultCombo: "", scope: "notes", descriptionKey: "notes:notesCommandToggleView" }
]
