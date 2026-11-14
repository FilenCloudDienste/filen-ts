import type { ActionDef } from "@/lib/keymap/registry"

// The keys every office editor shares (Word, spreadsheet, presentation, PDF). Show tabs only is Office's Ctrl+F1,
// Cmd+Option+R in Office for Mac. Print is one action for the spreadsheet, the presentation and the PDF viewer: each
// takes it wherever its file is shown, so the browser's own print (the app's chrome) never runs from the keyboard
// there; the spreadsheet grid matches it on its own keydown (spreadsheet/lib/keymap.ts sheetBindings).
export const OFFICE_ACTIONS: readonly ActionDef[] = [
	{
		id: "office.toggleRibbon",
		defaultCombo: "mod+f1",
		platformDefaults: [{ on: { mac: true }, combo: "mod+alt+r" }],
		scope: "editor",
		descriptionKey: "settings:keyboardActionToggleRibbon"
	},
	{
		id: "office.print",
		defaultCombo: "mod+p",
		scope: "editor",
		descriptionKey: "settings:keyboardActionPrint"
	}
]
