import type { DesktopFileProvider, DesktopMounts, DesktopSessionRead, DesktopSync, DesktopTransfers } from "@filen/shared/desktop"

// IPC channel names shared by main and the preload; the renderer never sees them.
export const CHANNELS = {
	setTitleBarColors: "window:set-title-bar-colors",
	windowState: "window:state",
	showWindow: "window:show",
	networkOnline: "app:network-online",
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
	setMediaTransport: "app:set-media-transport",
	quit: "app:quit",
	windowZoom: "window:zoom",
	windowToggleFullScreen: "window:toggle-full-screen",
	windowClose: "window:close",
	setMenuShortcuts: "app:set-menu-shortcuts",
	setShellStrings: "app:set-shell-strings",
	menuReady: "app:menu-ready",
	menuAction: "app:menu-action",
	updateReady: "app:update-ready",
	installUpdate: "app:install-update",
	browserCacheSize: "app:browser-cache-size",
	clearBrowserCache: "app:clear-browser-cache",
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
	mountsStats: "mounts:stats",
	transfersSubscribe: "transfers:subscribe",
	// Payload: DesktopTransferEvent[], what one host round (or one service step) changed, in order.
	transfersEvents: "transfers:events"
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
	"resolveConflicts",
	"heldDeletions",
	"approveDeletions",
	"restoreDeletions",
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

// The transfers bridge's requests, each answered on its own channel (transfersChannel). The page's Files reach main as
// paths (`upload` takes absolute paths); `onEvents` is the subscribe channel.
export const TRANSFERS_CALLS = [
	"download",
	"upload",
	"pickUpload",
	"cancel",
	"setPaused",
	"reveal",
	"open",
	"chooseDownloadDirectory"
] as const satisfies readonly (keyof DesktopTransfers)[]

export type TransfersCall = (typeof TRANSFERS_CALLS)[number]

// Items or ids one transfers call (and one host transfers op) may carry.
export const TRANSFER_ITEMS_MAX = 10_000

export function transfersChannel(call: TransfersCall): string {
	return `transfers:call:${call}`
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
