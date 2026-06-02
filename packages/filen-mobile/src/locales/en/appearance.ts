// Appearance settings screen vocabulary (src/routes/appearance/index.tsx). Shared keys
// (cancel, reset, close) live in common.ts and must not be redefined here.
export const appearance = {
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
	/** Settings row label: choose the light/dark appearance */
	theme: "Theme",
	/** Settings row subtitle for the theme option */
	theme_description: "Choose a light or dark appearance, or follow the system",
	/** Theme option: follow the device's system appearance */
	theme_system: "System",
	/** Theme option: always use the light appearance */
	theme_light: "Light",
	/** Theme option: always use the dark appearance */
	theme_dark: "Dark",
	/** Settings row label: remember the sort order separately for each directory */
	remember_sort_per_directory: "Remember sort per directory",
	/** Settings row subtitle explaining per-directory sort memory */
	remember_sort_per_directory_description: "Keep a separate sort order for every directory instead of one global order",
	/** Settings row label / confirm-dialog title: reset all saved sort orders */
	reset_sort: "Reset sort",
	/** Settings row subtitle explaining the reset-sort action */
	reset_sort_description: "Clear all saved sort orders and return to the defaults",
	/** Confirmation dialog message shown before resetting sort orders */
	reset_sort_confirm: "Are you sure you want to reset all saved sort orders?"
} as const
