import type { ActionDef } from "@/lib/keymap/registry"

// The drive listing's discrete commands. They are registered actions rather than intrinsic listbox
// keydown handling (useAction's useHotkeys binds document-wide, not scoped to the listbox element)
// so a user remap actually changes what fires and `<Kbd action>` reflects the real live combo. This
// makes them fire regardless of focus location on the page — an accepted, documented widening:
// every registered action fires globally (see useAction.ts on why no scope isolation exists), and
// each handler carries its own dialog guard. Arrow/Home/End/Space/Enter cursor movement stays
// listbox-local: continuous, per-row navigation, not discrete user-remappable commands.
//
// `drive.download`'s mod+s reads as "save to disk", the FSA picker's own verb. It is shared with
// `preview.save` deliberately — the two CAN co-mount (the preview overlay is hosted by the drive
// dialog host) and the listing's handler no-ops whenever a dialog is open.
export const DRIVE_ACTIONS: readonly ActionDef[] = [
	{ id: "drive.selectAll", defaultCombo: "mod+a", scope: "drive", descriptionKey: "drive:driveCommandSelectAll" },
	{ id: "drive.clearSelection", defaultCombo: "escape", scope: "drive", descriptionKey: "drive:driveCommandClearSelection" },
	{ id: "drive.toggleView", defaultCombo: "v", scope: "drive", descriptionKey: "drive:driveCommandToggleView" },
	{ id: "drive.rename", defaultCombo: "f2", scope: "drive", descriptionKey: "drive:driveCommandRename" },
	{ id: "drive.trash", defaultCombo: "delete,backspace", scope: "drive", descriptionKey: "drive:driveCommandTrash" },
	{ id: "drive.download", defaultCombo: "mod+s", scope: "drive", descriptionKey: "drive:driveCommandDownload" },
	{ id: "drive.newDirectory", defaultCombo: "n", scope: "drive", descriptionKey: "drive:driveCommandNewDirectory" },
	// Old-web parity: mod+f intercepts the browser's own find-in-page only while a drive listing is
	// mounted (the handler's preventDefault).
	{ id: "drive.search", defaultCombo: "mod+f", scope: "drive", descriptionKey: "drive:driveCommandSearch" }
]
