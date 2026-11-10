import type { ActionDef, PlatformDefault } from "@/lib/keymap/registry"

// Finder's keys on a Mac, Explorer's elsewhere.
function onMac(combo: string): readonly PlatformDefault[] {
	return [{ on: { mac: true }, combo }]
}

// The drive listing's discrete commands. They are registered actions rather than intrinsic listbox
// keydown handling (useAction's useHotkeys binds document-wide, not scoped to the listbox element)
// so a user remap actually changes what fires and `<Kbd action>` reflects the real live combo. This
// makes them fire regardless of focus location on the page — an accepted, documented widening:
// every registered action fires globally (see useAction.ts on why no scope isolation exists), and
// each handler carries its own dialog guard. Open and the item menu are scoped to the listbox instead:
// they act on the focused row, and Enter and Shift+F10 belong to whatever else has focus. Arrow, Home,
// End, PageUp, PageDown and Space cursor movement stays listbox-local: continuous, per-row navigation.
//
// `drive.download`'s mod+s reads as "save to disk", the FSA picker's own verb. It is shared with
// `preview.save` deliberately — the two CAN co-mount (the preview overlay is hosted by the drive
// dialog host) and the listing's handler no-ops whenever a dialog is open.
export const DRIVE_ACTIONS: readonly ActionDef[] = [
	{ id: "drive.selectAll", defaultCombo: "mod+a", scope: "drive", descriptionKey: "drive:driveCommandSelectAll" },
	{ id: "drive.clearSelection", defaultCombo: "escape", scope: "drive", descriptionKey: "common:clearSelection" },
	{
		id: "drive.open",
		defaultCombo: "enter",
		platformDefaults: onMac("enter,mod+arrowdown"),
		scope: "drive",
		descriptionKey: "drive:driveActionOpen",
		hintKey: "drive:driveCommandHintFocusedItem"
	},
	{
		id: "drive.goUp",
		defaultCombo: "alt+arrowup",
		platformDefaults: onMac("mod+arrowup"),
		scope: "drive",
		descriptionKey: "drive:driveCommandGoUp"
	},
	{
		id: "drive.openItemMenu",
		defaultCombo: "shift+f10",
		scope: "drive",
		descriptionKey: "drive:driveCommandOpenItemMenu",
		hintKey: "drive:driveCommandHintFocusedItem"
	},
	{ id: "drive.newDirectory", defaultCombo: "n", scope: "drive", descriptionKey: "drive:driveCommandNewDirectory" },
	// The file picker opens inside the keydown, the user gesture it needs.
	{ id: "drive.upload", defaultCombo: "u", scope: "drive", descriptionKey: "drive:driveUploadFiles" },
	{ id: "drive.uploadDirectory", defaultCombo: "shift+u", scope: "drive", descriptionKey: "drive:driveUploadDirectory" },
	{ id: "drive.rename", defaultCombo: "f2", scope: "drive", descriptionKey: "drive:driveCommandRename" },
	{
		id: "drive.info",
		defaultCombo: "alt+enter",
		platformDefaults: onMac("mod+i"),
		scope: "drive",
		descriptionKey: "drive:driveActionInfo"
	},
	{ id: "drive.toggleFavorite", defaultCombo: "s", scope: "drive", descriptionKey: "drive:driveCommandToggleFavorite" },
	// Drive's own clipboard (clipboard.ts). The handlers stand down in text fields and over a text
	// selection, and only preventDefault when they act, so text copy/paste keeps working everywhere.
	{ id: "drive.copy", defaultCombo: "mod+c", scope: "drive", descriptionKey: "drive:driveCommandCopy" },
	{ id: "drive.cut", defaultCombo: "mod+x", scope: "drive", descriptionKey: "drive:driveCommandCut" },
	{ id: "drive.paste", defaultCombo: "mod+v", scope: "drive", descriptionKey: "drive:driveCommandPaste" },
	{ id: "drive.move", defaultCombo: "m", scope: "drive", descriptionKey: "drive:driveActionMove" },
	{ id: "drive.download", defaultCombo: "mod+s", scope: "drive", descriptionKey: "drive:driveCommandDownload" },
	// What Delete does depends on the listing (driveDeleteKeyTarget): it stops a share in the shared views and
	// disables a link in Links.
	{
		id: "drive.trash",
		defaultCombo: "delete,backspace",
		scope: "drive",
		descriptionKey: "drive:driveCommandTrash",
		hintKey: "drive:driveCommandTrashHint"
	},
	{
		id: "drive.restore",
		defaultCombo: "r",
		scope: "drive",
		descriptionKey: "drive:driveActionRestore",
		hintKey: "drive:driveCommandHintTrash"
	},
	{
		id: "drive.deletePermanently",
		defaultCombo: "shift+delete",
		platformDefaults: onMac("mod+alt+backspace"),
		scope: "drive",
		descriptionKey: "drive:driveActionDeletePermanently",
		hintKey: "drive:driveCommandHintTrash"
	},
	// Old-web parity: mod+f intercepts the browser's own find-in-page only while a drive listing is
	// mounted (the handler's preventDefault).
	{ id: "drive.search", defaultCombo: "mod+f", scope: "drive", descriptionKey: "drive:driveCommandSearch" },
	{ id: "drive.toggleView", defaultCombo: "v", scope: "drive", descriptionKey: "drive:driveCommandToggleView" }
]
