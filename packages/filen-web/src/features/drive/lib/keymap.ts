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
	{ id: "drive.invertSelection", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandInvertSelection" },
	// Focus back on the listing's cursor row, from the search box or anywhere else on the page. ArrowDown in the
	// search box does the same.
	{ id: "drive.focusListing", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandFocusListing" },
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
	// A search hit's own directory, with the hit selected there.
	{
		id: "drive.openContainingDirectory",
		defaultCombo: "shift+enter",
		scope: "drive",
		descriptionKey: "drive:driveActionOpenContainingDirectory",
		hintKey: "drive:driveCommandHintSearchHit"
	},
	{ id: "drive.openAsText", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveActionOpenAsText" },
	{ id: "drive.newDirectory", defaultCombo: "n", scope: "drive", descriptionKey: "drive:driveCommandNewDirectory" },
	{ id: "drive.newTextFile", defaultCombo: "shift+n", scope: "drive", descriptionKey: "drive:driveNewTextFile" },
	// No default: Mod+Shift+N is the browser's, and no app has a key per office format.
	{ id: "drive.newDocx", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandNewDocx" },
	{ id: "drive.newXlsx", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandNewXlsx" },
	{ id: "drive.newPptx", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandNewPptx" },
	{ id: "drive.newOdt", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandNewOdt" },
	{ id: "drive.newOds", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandNewOds" },
	{ id: "drive.newOdp", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandNewOdp" },
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
	{ id: "drive.versions", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveActionVersions" },
	{ id: "drive.color", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveActionColor" },
	{ id: "drive.toggleFavorite", defaultCombo: "s", scope: "drive", descriptionKey: "drive:driveCommandToggleFavorite" },
	// The public link's URL straight to the clipboard, or the link dialog when there is none yet. Not Mod+Shift+C, the
	// browser's element picker.
	{ id: "drive.copyLink", defaultCombo: "mod+alt+c", scope: "drive", descriptionKey: "drive:driveActionCopyLink" },
	{ id: "drive.share", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveActionShare" },
	// Drive's own clipboard (clipboard.ts). The handlers stand down in text fields and over a text
	// selection, and only preventDefault when they act, so text copy/paste keeps working everywhere.
	{ id: "drive.copy", defaultCombo: "mod+c", scope: "drive", descriptionKey: "drive:driveCommandCopy" },
	{ id: "drive.cut", defaultCombo: "mod+x", scope: "drive", descriptionKey: "drive:driveCommandCut" },
	{ id: "drive.paste", defaultCombo: "mod+v", scope: "drive", descriptionKey: "drive:driveCommandPaste" },
	{ id: "drive.clearClipboard", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveClipboardClear" },
	{ id: "drive.move", defaultCombo: "m", scope: "drive", descriptionKey: "drive:driveActionMove" },
	{ id: "drive.copyTo", defaultCombo: "shift+m", scope: "drive", descriptionKey: "drive:driveCommandCopyTo" },
	// Compress, Extract and Download as open the selection bar's menus of the same name.
	{
		id: "drive.compress",
		defaultCombo: "",
		scope: "drive",
		descriptionKey: "drive:driveActionCompress",
		hintKey: "drive:driveCommandHintSelection"
	},
	{
		id: "drive.extract",
		defaultCombo: "",
		scope: "drive",
		descriptionKey: "drive:driveActionExtract",
		hintKey: "drive:driveCommandHintSelection"
	},
	{ id: "drive.download", defaultCombo: "mod+s", scope: "drive", descriptionKey: "drive:driveCommandDownload" },
	{
		id: "drive.downloadAs",
		defaultCombo: "mod+shift+s",
		scope: "drive",
		descriptionKey: "drive:driveCommandDownloadAs",
		hintKey: "drive:driveCommandHintSelection"
	},
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
	{
		id: "drive.emptyTrash",
		defaultCombo: "",
		scope: "drive",
		descriptionKey: "drive:driveActionEmptyTrash",
		hintKey: "drive:driveCommandHintTrash"
	},
	// Old-web parity: mod+f intercepts the browser's own find-in-page only while a drive listing is
	// mounted (the handler's preventDefault).
	{ id: "drive.search", defaultCombo: "mod+f", scope: "drive", descriptionKey: "drive:driveCommandSearch" },
	{ id: "drive.toggleView", defaultCombo: "v", scope: "drive", descriptionKey: "drive:driveCommandToggleView" },
	// No default: Mod+1 and Mod+2 switch browser tabs, and the desktop app's Mod+digits go to the modules.
	{ id: "drive.listView", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveViewList" },
	{ id: "drive.gridView", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveViewGrid" },
	{ id: "drive.cycleSort", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveCommandCycleSort" },
	// No default: Finder's Mod+Shift+. is kept for the assistant toggle.
	{ id: "drive.toggleHiddenItems", defaultCombo: "", scope: "drive", descriptionKey: "drive:driveShowHiddenItems" },
	// The browser's own reload keys reload the whole app, so only the desktop app, which has none, binds them.
	{
		id: "drive.refresh",
		defaultCombo: "",
		platformDefaults: [
			{ on: { desktop: true, mac: true }, combo: "mod+r" },
			{ on: { desktop: true }, combo: "f5" }
		],
		scope: "drive",
		descriptionKey: "drive:driveCommandRefresh"
	}
]
