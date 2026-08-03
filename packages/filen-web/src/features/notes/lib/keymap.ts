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
	{ id: "notes.clearSelection", defaultCombo: "escape", scope: "notes", descriptionKey: "notes:notesCommandClearSelection" },
	{ id: "notes.trash", defaultCombo: "delete,backspace", scope: "notes", descriptionKey: "notes:notesCommandTrash" },
	{ id: "notes.saveNow", defaultCombo: "mod+s", scope: "notes", descriptionKey: "notes:notesSaveAction" }
]
