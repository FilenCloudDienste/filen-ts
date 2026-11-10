import type { ActionDef } from "@/lib/keymap/registry"

// The keys every office editor's ribbon shares (Word, spreadsheet, presentation). Show tabs only is Office's Ctrl+F1,
// Cmd+Option+R in Office for Mac.
export const OFFICE_ACTIONS: readonly ActionDef[] = [
	{
		id: "office.toggleRibbon",
		defaultCombo: "mod+f1",
		platformDefaults: [{ on: { mac: true }, combo: "mod+alt+r" }],
		scope: "editor",
		descriptionKey: "settings:keyboardActionToggleRibbon"
	}
]
