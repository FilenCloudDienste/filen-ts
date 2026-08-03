import type { ActionDef } from "@/lib/keymap/registry"

// App-level shortcuts: the theme toggle (themeProvider) and the rail's route-nav commands plus the
// shortcuts overlay (iconRail's AccountMenu). The four route-nav commands ship UNASSIGNED
// (defaultCombo "" — react-hotkeys-hook's parser treats an empty combo as matching no key, so they
// never fire until a user rebinds them): the keyboard-first contract requires every action be
// user-mappable, not that every action ship with a default.
//
// `app.openShortcuts` matches by `event.code`, so on a non-US layout the physical slash key is not
// `?`. Accepted — the account-menu entry and Settings → Keyboard are the layout-independent paths,
// and a user on such a layout can rebind it there.
export const APP_ACTIONS: readonly ActionDef[] = [
	{ id: "app.toggleTheme", defaultCombo: "d", scope: "global", descriptionKey: "common:toggleTheme" },
	{ id: "app.openShortcuts", defaultCombo: "shift+slash", scope: "global", descriptionKey: "common:shortcutsTitle" },
	{ id: "app.openSettings", defaultCombo: "", scope: "global", descriptionKey: "common:settings" },
	{ id: "app.openTransfers", defaultCombo: "", scope: "global", descriptionKey: "common:moduleTransfers" },
	{ id: "app.openPlaylists", defaultCombo: "", scope: "global", descriptionKey: "common:modulePlaylists" },
	{ id: "app.openPhotos", defaultCombo: "", scope: "global", descriptionKey: "common:modulePhotos" }
]
