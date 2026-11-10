import type { ActionDef } from "@/lib/keymap/registry"

// App-level shortcuts: the theme (themeProvider), the rail's route-nav commands, the shortcuts overlay (shortcutsHost),
// the assistant panel toggle (assistantToggle), the shell's sidebar and focus areas (appShell), the notifications
// (sonner) and the desktop app's window keys (desktopWindowKeys). An action without a sensible free key ships
// UNASSIGNED (defaultCombo "" matches no key until a user binds it): the keyboard-first contract requires every action
// be user-mappable, not that every action ship with a default.
//
// `app.toggleAssistant` ships unassigned too. Its `global` scope co-mounts with every other scope
// (conflicts.ts), so a default must avoid every shipped combo. The free modifier chords belong to the
// browser (mod+j downloads, mod+l address bar, mod+shift+a tab search) or to the editors' own
// CodeMirror/Quill keys, which the tables do not model. Bare letters are free, but one stray keypress
// reflowing the whole content column is not a default worth shipping.
//
// `app.openSettings` is Mod+, as in every desktop app; a Mac browser keeps Cmd+, for its own settings, so the web on
// a Mac leaves it unassigned.
//
// Going to a module: the desktop app has Mod+1..6 (Slack's and Teams' keys); a browser keeps Mod+1..9 for its tabs.
//
// `app.openShortcuts` matches by `event.code`, so on a non-US layout the physical slash key is not
// `?`. Accepted — the account-menu entry and Settings → Keyboard are the layout-independent paths,
// and a user on such a layout can rebind it there.
const DESKTOP = { desktop: true } as const
// The window keys a Mac's menu bar already has (zoom, full screen, quit) exist on Windows and Linux only.
const DESKTOP_OFF_MAC = { desktop: true, mac: false } as const

function moduleAction(id: string, descriptionKey: ActionDef["descriptionKey"], digit: number): ActionDef {
	return {
		id,
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP, combo: `mod+${String(digit)}` }],
		scope: "global",
		descriptionKey
	}
}

export const APP_ACTIONS: readonly ActionDef[] = [
	{ id: "app.openShortcuts", defaultCombo: "shift+slash", scope: "global", descriptionKey: "common:shortcutsTitle" },
	{
		id: "app.openSettings",
		defaultCombo: "mod+comma",
		platformDefaults: [{ on: { mac: true, desktop: false }, combo: "" }],
		scope: "global",
		descriptionKey: "common:settings"
	},
	{ id: "app.openTransfers", defaultCombo: "", scope: "global", descriptionKey: "common:moduleTransfers" },
	{ id: "app.openPhotos", defaultCombo: "", scope: "global", descriptionKey: "common:modulePhotos" },
	{ id: "app.openVideos", defaultCombo: "", scope: "global", descriptionKey: "common:moduleVideos" },
	{ id: "app.openPlaylists", defaultCombo: "", scope: "global", descriptionKey: "common:modulePlaylists" },
	{ id: "app.toggleAssistant", defaultCombo: "", scope: "global", descriptionKey: "common:toggleAssistant" },
	{ id: "app.toggleTheme", defaultCombo: "d", scope: "global", descriptionKey: "common:toggleTheme" },
	moduleAction("app.openDrive", "common:moduleDrive", 1),
	moduleAction("app.openNotes", "common:moduleNotes", 2),
	moduleAction("app.openChats", "common:moduleChats", 3),
	moduleAction("app.openContacts", "common:moduleContacts", 4),
	{ ...moduleAction("app.openSync", "common:moduleSync", 5), only: DESKTOP },
	{ ...moduleAction("app.openMounts", "common:moduleMounts", 6), only: DESKTOP },
	{ id: "app.openRecents", defaultCombo: "", scope: "global", descriptionKey: "drive:driveRecents" },
	{ id: "app.openFavorites", defaultCombo: "", scope: "global", descriptionKey: "drive:driveFavorites" },
	{ id: "app.openSharedIn", defaultCombo: "", scope: "global", descriptionKey: "common:driveSharedIn" },
	{ id: "app.openSharedOut", defaultCombo: "", scope: "global", descriptionKey: "common:driveSharedOut" },
	{ id: "app.openLinks", defaultCombo: "", scope: "global", descriptionKey: "common:driveLinks" },
	{ id: "app.openTrash", defaultCombo: "", scope: "global", descriptionKey: "drive:driveTrash" },
	// VS Code's, Slack's and Notion's sidebar key. The PDF viewer's fit toggle holds it too, inside the preview, where
	// every shell key stands down.
	{ id: "app.toggleSidebar", defaultCombo: "mod+backslash", scope: "global", descriptionKey: "settings:keyboardActionToggleSidebar" },
	// F6 moves between the window's areas in every desktop app and browser (rail, sidebar, content, assistant).
	{ id: "app.nextPane", defaultCombo: "f6", scope: "global", descriptionKey: "settings:keyboardActionNextPane" },
	{ id: "app.previousPane", defaultCombo: "shift+f6", scope: "global", descriptionKey: "settings:keyboardActionPreviousPane" },
	// The notifications' own key until now (the toast library's default).
	{
		id: "app.focusNotifications",
		defaultCombo: "alt+t",
		scope: "global",
		descriptionKey: "settings:keyboardActionFocusNotifications"
	},
	{
		id: "app.dismissNotifications",
		defaultCombo: "",
		scope: "global",
		descriptionKey: "settings:keyboardActionDismissNotifications"
	},
	{ id: "app.themeLight", defaultCombo: "", scope: "global", descriptionKey: "settings:keyboardActionThemeLight" },
	{ id: "app.themeDark", defaultCombo: "", scope: "global", descriptionKey: "settings:keyboardActionThemeDark" },
	{ id: "app.themeSystem", defaultCombo: "", scope: "global", descriptionKey: "settings:keyboardActionThemeSystem" },
	{ id: "app.openAccountMenu", defaultCombo: "", scope: "global", descriptionKey: "settings:keyboardActionAccountMenu" },
	{ id: "app.signOut", defaultCombo: "", scope: "global", descriptionKey: "common:signOut" },
	// Mod+L is the address bar and Mod+Shift+L CodeMirror's select-all-matches.
	{
		id: "app.lock",
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP, combo: "mod+alt+l" }],
		scope: "global",
		descriptionKey: "settings:keyboardActionLock",
		only: DESKTOP
	},
	// Closes the open dialog first (a file preview, as a Mac closes a document window), the window when none is open.
	{
		id: "desktop.close",
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP, combo: "mod+w" }],
		scope: "global",
		descriptionKey: "settings:keyboardActionClose",
		only: DESKTOP
	},
	// A Mac's are Cmd+[ and Cmd+], Finder's and Safari's; they stand down under the preview, whose PDF rotation and
	// object order hold them.
	{
		id: "desktop.back",
		defaultCombo: "",
		platformDefaults: [
			{ on: { desktop: true, mac: true }, combo: "mod+bracketleft" },
			{ on: DESKTOP, combo: "alt+arrowleft" }
		],
		scope: "global",
		descriptionKey: "settings:keyboardActionBack",
		only: DESKTOP
	},
	{
		id: "desktop.forward",
		defaultCombo: "",
		platformDefaults: [
			{ on: { desktop: true, mac: true }, combo: "mod+bracketright" },
			{ on: DESKTOP, combo: "alt+arrowright" }
		],
		scope: "global",
		descriptionKey: "settings:keyboardActionForward",
		only: DESKTOP
	},
	// A browser's zoom keys: the "+", "-" and "0" characters wherever the layout puts them (desktopWindowKeys), so these
	// combos only name the keys on a US keyboard.
	{
		id: "desktop.zoomIn",
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP_OFF_MAC, combo: "mod+equal" }],
		scope: "global",
		descriptionKey: "settings:keyboardActionZoomIn",
		only: DESKTOP_OFF_MAC
	},
	{
		id: "desktop.zoomOut",
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP_OFF_MAC, combo: "mod+minus" }],
		scope: "global",
		descriptionKey: "settings:keyboardActionZoomOut",
		only: DESKTOP_OFF_MAC
	},
	{
		id: "desktop.zoomReset",
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP_OFF_MAC, combo: "mod+0" }],
		scope: "global",
		descriptionKey: "settings:keyboardActionZoomReset",
		only: DESKTOP_OFF_MAC
	},
	{
		id: "desktop.fullScreen",
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP_OFF_MAC, combo: "f11" }],
		scope: "global",
		descriptionKey: "settings:keyboardActionFullScreen",
		only: DESKTOP_OFF_MAC
	},
	{
		id: "desktop.quit",
		defaultCombo: "",
		platformDefaults: [{ on: DESKTOP_OFF_MAC, combo: "mod+q" }],
		scope: "global",
		descriptionKey: "settings:keyboardActionQuit",
		only: DESKTOP_OFF_MAC
	}
]
