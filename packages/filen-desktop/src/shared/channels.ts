import type { DesktopFileProvider, DesktopMounts, DesktopSessionRead, DesktopSync } from "@filen/shared/desktop"

// IPC channel names shared by main and the preload; the renderer never sees them.
export const CHANNELS = {
	setTitleBarColors: "window:set-title-bar-colors",
	windowState: "window:state",
	showWindow: "window:show",
	sessionGet: "session:get",
	sessionSet: "session:set",
	sessionClear: "session:clear",
	sessionDiscardUnreadable: "session:discard-unreadable",
	sessionVerified: "session:verified",
	sessionRevoked: "session:revoked",
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
	logsExport: "logs:export",
	syncSubscribe: "sync:subscribe",
	syncOverview: "sync:overview",
	syncActivity: "sync:activity",
	syncOpenPair: "sync:open-pair",
	mountsSubscribe: "mounts:subscribe",
	mountsOverview: "mounts:overview",
	mountsStats: "mounts:stats"
} as const

// The sync bridge's requests, each answered on its own channel (syncChannel).
export const SYNC_CALLS = [
	"overview",
	"activity",
	"chooseLocalDirectory",
	"addPair",
	"startPair",
	"removePair",
	"pausePair",
	"resumePair",
	"setMode",
	"renamePair",
	"syncNow",
	"plan",
	"planPage",
	"releasePlan",
	"conflicts",
	"resolveConflict",
	"heldDeletions",
	"approveDeletions",
	"retryPath",
	"retryAll",
	"unsyncablePaths",
	"ignoredPaths",
	"userIgnore",
	"setUserIgnore",
	"reveal",
	"dismissNotice",
	"holdAction",
	"dismissInfo",
	"dismissImportNote",
	"retryHost"
] as const satisfies readonly (keyof DesktopSync)[]

export type SyncCall = (typeof SYNC_CALLS)[number]

export function syncChannel(call: SyncCall): string {
	return `sync:call:${call}`
}

// The mounts bridge's requests, each answered on its own channel (mountsChannel).
export const MOUNTS_CALLS = [
	"overview",
	"stats",
	"chooseMountPoint",
	"driveLetters",
	"setDrive",
	"listenAddresses",
	"setServe",
	"credentials",
	"copyCredential",
	"setCredentials",
	"regenerateCredentials",
	"setTuning",
	"clearCache",
	"installFuse",
	"revealDrive",
	"confirmSignOut",
	"dismissNotice",
	"retryHost"
] as const satisfies readonly (keyof DesktopMounts)[]

export type MountsCall = (typeof MOUNTS_CALLS)[number]

export function mountsChannel(call: MountsCall): string {
	return `mounts:call:${call}`
}

// The File Provider bridge's requests, each answered on its own channel (fileProviderChannel).
export const FILE_PROVIDER_CALLS = [
	"state",
	"enable",
	"disable",
	"reveal",
	"openSettings"
] as const satisfies readonly (keyof DesktopFileProvider)[]

export type FileProviderCall = (typeof FILE_PROVIDER_CALLS)[number]

export function fileProviderChannel(call: FileProviderCall): string {
	return `fileProvider:${call}`
}

// What a page listens to: the overview, the stats, or both.
export interface MountsSubscription {
	overview: boolean
	stats: boolean
}

// The preload reads the app version from this argument, so the page gets it without a round trip.
export const VERSION_ARG_PREFIX = "--filen-app-version="

// Present when Filen in Finder is supported, so the page knows it without a round trip.
export const FILE_PROVIDER_ARG = "--filen-file-provider"

// What `session:get` and `session:discard-unreadable` answer. An error thrown by an IPC handler reaches the page only
// as a wrapped message, so the unreadable case travels as data.
export type SessionRead = DesktopSessionRead

// A real session is a few KB (an RSA private key plus the master-key chain, ~65 bytes a key); this leaves room
// for thousands of keys and only stops an unbounded payload.
export const SESSION_BLOB_MAX_LENGTH = 1024 * 1024
