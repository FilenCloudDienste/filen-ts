import type { ActionDef } from "@/lib/keymap/registry"

// Settings' own keys. Section stepping walks the sidebar's links in order. Search focuses the box of the page or list
// on screen: the Events page's, and the shortcuts list's (Settings → Keyboard and the `?` dialog), each only in its
// own layer. The event keys act in an event's details dialog only; ← and → step through the events the list shows,
// since ↑ and ↓ scroll the details.
export const SETTINGS_ACTIONS: readonly ActionDef[] = [
	{
		id: "settings.previousSection",
		defaultCombo: "alt+arrowup",
		scope: "settings",
		descriptionKey: "settings:keyboardActionPreviousSection"
	},
	{ id: "settings.nextSection", defaultCombo: "alt+arrowdown", scope: "settings", descriptionKey: "settings:keyboardActionNextSection" },
	{
		id: "settings.search",
		defaultCombo: "mod+f",
		scope: "settings",
		descriptionKey: "settings:keyboardActionSearch",
		hintKey: "settings:keyboardHintSettingsSearch"
	},
	{
		id: "settings.previousEvent",
		defaultCombo: "arrowleft",
		scope: "settings",
		descriptionKey: "settings:keyboardActionPreviousEvent",
		hintKey: "settings:keyboardHintEventDetails"
	},
	{
		id: "settings.nextEvent",
		defaultCombo: "arrowright",
		scope: "settings",
		descriptionKey: "settings:keyboardActionNextEvent",
		hintKey: "settings:keyboardHintEventDetails"
	},
	{
		id: "settings.copyEvent",
		defaultCombo: "mod+c",
		scope: "settings",
		descriptionKey: "settings:keyboardActionCopyEvent",
		hintKey: "settings:keyboardHintEventDetails"
	},
	{
		id: "settings.showEventInDrive",
		defaultCombo: "mod+enter",
		scope: "settings",
		descriptionKey: "settings:keyboardActionShowEventInDrive",
		hintKey: "settings:keyboardHintEventDetails"
	}
]
