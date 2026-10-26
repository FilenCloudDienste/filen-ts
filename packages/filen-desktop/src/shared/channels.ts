// IPC channel names shared by main and the preload; the renderer never sees them.
export const CHANNELS = {
	setTitleBarColors: "window:set-title-bar-colors",
	windowState: "window:state",
	showWindow: "window:show",
	sessionGet: "session:get",
	sessionSet: "session:set",
	sessionClear: "session:clear",
	prefsGet: "prefs:get",
	prefsSet: "prefs:set",
	setBadge: "app:set-badge",
	setUnloadHolds: "app:set-unload-holds",
	setAudioPlaying: "app:set-audio-playing",
	setMenuShortcuts: "app:set-menu-shortcuts",
	menuReady: "app:menu-ready",
	menuAction: "app:menu-action",
	updateReady: "app:update-ready",
	installUpdate: "app:install-update",
	lockStatus: "lock:status",
	lockChanged: "lock:changed",
	lockUnlock: "lock:unlock",
	lockSet: "lock:set",
	lockClear: "lock:clear",
	lockNow: "lock:now",
	lockReset: "lock:reset",
	logsExport: "logs:export"
} as const

// The preload reads the app version from this argument, so the page gets it without a round trip.
export const VERSION_ARG_PREFIX = "--filen-app-version="

// What `session:get` answers. An error thrown by an IPC handler reaches the preload only as a wrapped message, so
// the unreadable case travels as data and the preload turns it into the rejection the bridge documents.
export type SessionRead = { status: "absent" } | { status: "present"; blob: string } | { status: "unreadable" }
