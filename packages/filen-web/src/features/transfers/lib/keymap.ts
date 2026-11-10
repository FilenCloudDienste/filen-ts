import type { ActionDef } from "@/lib/keymap/registry"

// The /transfers page's commands. Pause/resume all is Alt+Shift+P: Mod+Shift+P is Firefox's private window and Mod+Alt+P
// the audio player's play/pause, both mounted with this page. Clear finished stays unset: Mod+Shift+K, the report's
// pick, is Firefox's web console.
//
// The row commands act on the focused row of the list only (ref-scoped, and only when the row itself has focus, so a
// row button keeps its own Space and Enter); arrows, Home and End move between the rows.
export const TRANSFERS_ACTIONS: readonly ActionDef[] = [
	{
		id: "transfers.togglePauseAll",
		defaultCombo: "alt+shift+p",
		scope: "transfers",
		descriptionKey: "transfers:transfersCommandTogglePauseAll"
	},
	{
		id: "transfers.cancelAll",
		defaultCombo: "mod+shift+backspace",
		scope: "transfers",
		descriptionKey: "transfers:transfersCommandCancelAll"
	},
	{ id: "transfers.clearFinished", defaultCombo: "", scope: "transfers", descriptionKey: "transfers:transfersClearFinished" },
	{
		id: "transfers.rowPause",
		defaultCombo: "space",
		scope: "transfers",
		descriptionKey: "transfers:transfersCommandRowPause",
		hintKey: "transfers:transfersHintRow"
	},
	{
		id: "transfers.rowCancel",
		defaultCombo: "delete",
		scope: "transfers",
		descriptionKey: "transfers:transfersCommandRowCancel",
		hintKey: "transfers:transfersHintRow"
	},
	{
		id: "transfers.rowShowInDirectory",
		defaultCombo: "enter",
		scope: "transfers",
		descriptionKey: "transfers:transfersCommandRowShowInDirectory",
		hintKey: "transfers:transfersHintRow"
	},
	{
		id: "transfers.rowDetails",
		defaultCombo: "i",
		scope: "transfers",
		descriptionKey: "transfers:transfersCommandRowDetails",
		hintKey: "transfers:transfersHintRow"
	}
]
