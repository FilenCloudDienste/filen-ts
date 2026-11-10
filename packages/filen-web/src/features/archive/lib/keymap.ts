import type { ActionDef, PlatformDefault } from "@/lib/keymap/registry"

// The archive browser's keys (archiveBrowser.logic.ts browserKeyAction), with the list focused: Enter opens a directory
// or the file under the cursor (Cmd+Down too on a Mac, as in Finder), Backspace or Alt+Up goes to the parent (Cmd+Up on
// a Mac), Space toggles the row, Escape clears the selection, "/" finds (as does editor.find), Mod+S saves the file,
// Shift+F10 opens its menu. In a file opened from the archive, Escape or Alt+Left (Cmd+[ on a Mac) goes back to the
// list. The cursor's moves (the vertical arrows, Home, End, Page Up and Down) stay the list's own, as in every listbox,
// and select all follows drive.selectAll.
export type ArchiveAction =
	| "archive.open"
	| "archive.parent"
	| "archive.toggle"
	| "archive.clearSelection"
	| "archive.search"
	| "archive.download"
	| "archive.openMenu"
	| "archive.extractSelected"
	| "archive.extractAll"
	| "archive.back"

function archiveAction(
	id: ArchiveAction,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"],
	mac?: string
): ActionDef & { readonly id: ArchiveAction } {
	const platformDefaults: readonly PlatformDefault[] | undefined = mac === undefined ? undefined : [{ on: { mac: true }, combo: mac }]

	return {
		id,
		defaultCombo,
		...(platformDefaults === undefined ? {} : { platformDefaults }),
		scope: "editor",
		section: "archive",
		descriptionKey
	}
}

export const ARCHIVE_ACTIONS: readonly (ActionDef & { readonly id: ArchiveAction })[] = [
	archiveAction("archive.open", "enter", "preview:previewKeyArchiveOpen", "enter,mod+arrowdown"),
	archiveAction("archive.parent", "backspace,alt+arrowup", "preview:previewKeyArchiveParent", "backspace,mod+arrowup,alt+arrowup"),
	archiveAction("archive.toggle", "space", "preview:previewKeyArchiveToggle"),
	archiveAction("archive.clearSelection", "escape", "preview:previewKeyArchiveClearSelection"),
	archiveAction("archive.search", "slash", "preview:previewKeyArchiveSearch"),
	archiveAction("archive.download", "mod+s", "preview:previewKeyArchiveDownload"),
	archiveAction("archive.openMenu", "shift+f10", "preview:previewKeyArchiveOpenMenu"),
	archiveAction("archive.extractSelected", "", "preview:previewKeyArchiveExtractSelected"),
	archiveAction("archive.extractAll", "", "preview:previewKeyArchiveExtractAll"),
	archiveAction("archive.back", "escape,alt+arrowleft", "preview:previewKeyArchiveBack", "escape,mod+bracketleft")
]
