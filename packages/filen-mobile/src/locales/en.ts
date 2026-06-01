// English translation catalog — the source language for every other locale.
//
// Format: a flat (no nesting) `as const` object of snake_case keys → English copy, with one
// `/** JSDoc */` per key giving translator context. Comments strip at build; the `as const`
// gives full key-type-safety (see src/i18next.d.ts). i18next runs with `keySeparator:false`
// and `nsSeparator:false`, so keys are treated as opaque flat literals (dots/colons in a key
// are literal characters, not path separators).
//
// PLURAL/CONTEXT SEPARATOR RULE (Risk 1): `keySeparator:false` does NOT disable i18next's
// `pluralSeparator`/`contextSeparator`, both of which default to `_`. Because these keys are
// snake_case, the first pluralized/context key (i18next appends `_one`/`_other`/`_male`/…)
// would collide with snake_case. Inert in Phase 1 (no plurals/contexts here). When the first
// plural lands, override `pluralSeparator`/`contextSeparator` to a snake-safe value
// (e.g. `"__"`), and ensure no base key ends in a token that could collide.
//
// Native language names (English, Deutsch, …) do NOT live here — they are non-translated
// constants in src/lib/language.ts.
export const en = {
	/** Appearance settings screen — header title */
	appearance: "Appearance",
	/** Settings row label: choose which tab opens on launch */
	start_screen: "Start screen",
	/** Settings row subtitle explaining the start-screen option */
	start_screen_description: "Choose the screen shown when the app opens",
	/** Start-screen option: the file browser (Drive) tab */
	start_screen_drive: "Drive",
	/** Start-screen option: the Photos tab */
	start_screen_photos: "Photos",
	/** Start-screen option: the Notes tab */
	start_screen_notes: "Notes",
	/** Start-screen option: the Chats tab */
	start_screen_chats: "Chats",
	/** Start-screen option: the More (settings) tab */
	start_screen_more: "More",
	/** Settings row label: choose the app display language */
	language: "Language",
	/** Settings row subtitle for the language option */
	language_description: "Choose the language used throughout the app",
	/** Settings row label: remember the sort order separately for each directory */
	remember_sort_per_directory: "Remember sort per directory",
	/** Settings row subtitle explaining per-directory sort memory */
	remember_sort_per_directory_description: "Keep a separate sort order for every directory instead of one global order",
	/** Settings row label / confirm-dialog title: reset all saved sort orders */
	reset_sort: "Reset sort",
	/** Settings row subtitle explaining the reset-sort action */
	reset_sort_description: "Clear all saved sort orders and return to the defaults",
	/** Confirmation dialog message shown before resetting sort orders */
	reset_sort_confirm: "Are you sure you want to reset all saved sort orders?",
	/** Generic confirm/destructive action button: reset */
	reset: "Reset",
	/** Generic dialog cancel button */
	cancel: "Cancel",
	/** Generic action-sheet dismiss button */
	close: "Close"
} as const
