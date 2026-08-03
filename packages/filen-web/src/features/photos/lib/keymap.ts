import type { ActionDef } from "@/lib/keymap/registry"

// The photos grid's selection commands. They describe themselves with the drive namespace's own
// command copy — the wording is identical and duplicating it into `photos` would be two strings to
// keep in sync. Same combos as drive's, safe because the two routes are mutually exclusive.
export const PHOTOS_ACTIONS: readonly ActionDef[] = [
	{ id: "photos.selectAll", defaultCombo: "mod+a", scope: "photos", descriptionKey: "drive:driveCommandSelectAll" },
	{ id: "photos.clearSelection", defaultCombo: "escape", scope: "photos", descriptionKey: "drive:driveCommandClearSelection" },
	{ id: "photos.trash", defaultCombo: "delete,backspace", scope: "photos", descriptionKey: "drive:driveCommandTrash" }
]
