import type { ActionDef } from "@/lib/keymap/registry"

// App-level shortcuts: the theme toggle (themeProvider) and the rail's route-nav commands plus the
// shortcuts overlay (iconRail's AccountMenu) and the assistant panel toggle (assistantToggle). The four
// route-nav commands ship UNASSIGNED (defaultCombo "" — react-hotkeys-hook's parser treats an empty combo
// as matching no key, so they never fire until a user rebinds them): the keyboard-first contract requires
// every action be user-mappable, not that every action ship with a default.
//
// `app.toggleAssistant` ships unassigned too. Its `global` scope co-mounts with every other scope
// (conflicts.ts), so a default must avoid every shipped combo. The free modifier chords belong to the
// browser (mod+j downloads, mod+l address bar, mod+shift+a tab search) or to the editors' own
// CodeMirror/Quill keys, which the tables do not model. Bare letters are free, but one stray keypress
// reflowing the whole content column is not a default worth shipping.
//
// `app.openSettings` is Cmd+, in the macOS desktop app, as in every Mac app; a Mac browser keeps Cmd+, for its own
// settings, so the web leaves it unassigned there too.
//
// `app.openShortcuts` matches by `event.code`, so on a non-US layout the physical slash key is not
// `?`. Accepted — the account-menu entry and Settings → Keyboard are the layout-independent paths,
// and a user on such a layout can rebind it there.
export const APP_ACTIONS: readonly ActionDef[] = [
	{ id: "app.openShortcuts", defaultCombo: "shift+slash", scope: "global", descriptionKey: "common:shortcutsTitle" },
	{
		id: "app.openSettings",
		defaultCombo: "",
		platformDefaults: [{ on: { mac: true, desktop: true }, combo: "mod+comma" }],
		scope: "global",
		descriptionKey: "common:settings"
	},
	{ id: "app.openTransfers", defaultCombo: "", scope: "global", descriptionKey: "common:moduleTransfers" },
	{ id: "app.openPhotos", defaultCombo: "", scope: "global", descriptionKey: "common:modulePhotos" },
	{ id: "app.openVideos", defaultCombo: "", scope: "global", descriptionKey: "common:moduleVideos" },
	{ id: "app.openPlaylists", defaultCombo: "", scope: "global", descriptionKey: "common:modulePlaylists" },
	{ id: "app.toggleAssistant", defaultCombo: "", scope: "global", descriptionKey: "common:toggleAssistant" },
	{ id: "app.toggleTheme", defaultCombo: "d", scope: "global", descriptionKey: "common:toggleTheme" }
]
