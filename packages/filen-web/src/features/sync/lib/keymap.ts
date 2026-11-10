import type { ActionDef } from "@/lib/keymap/registry"

// The Sync section's keys (desktop app). Pause/resume and Sync now ship unset: Mod+R is the page's reload, and no
// other chord says either. The tabs ship unset too: Mod+1…4 belong to the browser's tabs and to module navigation.
// Remove is Delete, plus Cmd+Backspace on a Mac (Finder's), whose laptop keyboards have no Delete key.
const DESKTOP = { desktop: true } as const

const DEFS: readonly ActionDef[] = [
	{ id: "sync.addPair", defaultCombo: "n", scope: "sync", descriptionKey: "sync:syncCommandAddPair" },
	{ id: "sync.previousPair", defaultCombo: "alt+arrowup", scope: "sync", descriptionKey: "sync:syncCommandPreviousPair" },
	{ id: "sync.nextPair", defaultCombo: "alt+arrowdown", scope: "sync", descriptionKey: "sync:syncCommandNextPair" },
	{ id: "sync.togglePause", defaultCombo: "", scope: "sync", descriptionKey: "sync:syncCommandTogglePause" },
	{ id: "sync.syncNow", defaultCombo: "", scope: "sync", descriptionKey: "sync:syncCommandSyncNow" },
	{
		id: "sync.removePair",
		defaultCombo: "delete",
		platformDefaults: [{ on: { mac: true }, combo: "delete,mod+backspace" }],
		scope: "sync",
		descriptionKey: "sync:syncCommandRemovePair"
	},
	{ id: "sync.startReview", defaultCombo: "mod+enter", scope: "sync", descriptionKey: "sync:syncCommandStartReview" },
	{
		id: "sync.saveIgnoreRules",
		defaultCombo: "mod+s",
		scope: "sync",
		descriptionKey: "sync:syncCommandSaveIgnoreRules",
		hintKey: "sync:syncCommandHintIgnoreEditor"
	},
	{ id: "sync.tabActivity", defaultCombo: "", scope: "sync", descriptionKey: "sync:syncCommandTabActivity" },
	{ id: "sync.tabIssues", defaultCombo: "", scope: "sync", descriptionKey: "sync:syncCommandTabIssues" },
	{ id: "sync.tabIgnored", defaultCombo: "", scope: "sync", descriptionKey: "sync:syncCommandTabIgnored" },
	{ id: "sync.tabSettings", defaultCombo: "", scope: "sync", descriptionKey: "sync:syncCommandTabSettings" }
]

// Sync exists in the desktop app only, so a browser's shortcuts list leaves these out.
export const SYNC_ACTIONS: readonly ActionDef[] = DEFS.map(def => ({ ...def, only: DESKTOP }))
