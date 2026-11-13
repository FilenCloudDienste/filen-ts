// The contract between the Filen web app and the desktop shell's preload, exposed as `window.desktop`.
// Types only: the browser build pays nothing for it, and an absent `window.desktop` means a plain browser.

import type { DesktopLockAfterSeconds } from "./desktopLock"
import type { DesktopShellStringsPayload } from "./desktopShellStrings"

export type DesktopPlatform = "darwin" | "win32" | "linux"

// Window chrome colours (CSS colour strings): the controls overlay Windows and Linux draw top-right, and the border
// Windows 11 draws around the window.
export interface TitleBarColors {
	color: string
	symbolColor: string
	border: string
}

// `drawsBorder`: the OS draws no window border (Windows 10), so the page draws one while the window is neither
// maximized, fullscreen nor snapped.
export interface WindowState {
	maximized: boolean
	fullScreen: boolean
	snapped: boolean
	drawsBorder: boolean
}

// The stored session. "unreadable": one is stored but cannot be read now (locked keychain, changed desktop
// environment, a key that is gone); that is not a sign-out, so the caller must not clear anything.
export type DesktopSessionRead = { status: "absent" } | { status: "present"; blob: string } | { status: "unreadable" }

// The SDK session kept by the shell in the OS keychain-backed vault instead of web storage. `blob` is the session as
// the web's envelope JSON (bigint-safe); the shell checks its shape and never reads the keys.
export interface DesktopSessionVault {
	get(): Promise<DesktopSessionRead>
	set(blob: string): Promise<void>
	clear(): Promise<void>
	// The user gave up on an unreadable session. Main reads it again first and keeps one that decrypts now. Otherwise
	// it removes it and every other file its key encrypted that no longer decrypts (the PIN, the migration stash, mount
	// credentials), then answers "absent". Nothing is signed out on the server.
	discardUnreadable(): Promise<DesktopSessionRead>
	// The stored session just passed its first authed request of this page. The shell uses it once, to retire what
	// the old desktop client left behind after its account was migrated.
	markVerified(): void
	// The server rejected the stored session (a revoked API key) while the shell used it for sync: the shell already
	// removed it, so the page must sign out. Calls back right away when that happened before subscribing.
	onRevoked(callback: () => void): () => void
}

// Shell preferences, kept by main in userData. `launchAtLogin` starts the app hidden. `chatNotifications` or
// `contactNotifications` also keeps the hidden window's page alive, since it owns the socket those come from;
// `syncNotifications` covers main's own sync and mount alerts. `notificationSound` lets both play the OS sound.
// `lockAfterSeconds` applies only while a PIN is set. `downloadDirectory`: where downloads go without asking, null to ask
// every time; only main's own directory picker sets a path.
export interface DesktopPrefs {
	minimizeToTray: boolean
	startMinimized: boolean
	launchAtLogin: boolean
	lockAfterSeconds: DesktopLockAfterSeconds
	chatNotifications: boolean
	contactNotifications: boolean
	syncNotifications: boolean
	notificationSound: boolean
	downloadDirectory: string | null
}

// What the page may change: any pref, except that the download directory can only go back to null (ask every time).
export type DesktopPrefsPatch = Partial<Omit<DesktopPrefs, "downloadDirectory">> & { downloadDirectory?: null }

export interface DesktopPrefsStore {
	get(): Promise<DesktopPrefs>
	// Resolves with the prefs now in effect.
	set(patch: DesktopPrefsPatch): Promise<DesktopPrefs>
}

// The web keymap actions the macOS menu offers. Main shows each with the combo the web reports and sends the id back
// when the item is clicked; the web stays the only key dispatcher.
export type DesktopMenuAction =
	| "app.openSettings"
	| "app.openShortcuts"
	| "app.toggleTheme"
	| "app.toggleAssistant"
	| "app.openTransfers"
	| "app.lock"
	| "desktop.close"
	| "audio.playPause"
	| "audio.next"
	| "audio.previous"
	| "audio.shuffle"
	| "audio.loop"

// The audio player's state as the menu and the tray offer its transport: nothing queued, or a queue paused or playing.
export type DesktopMediaTransport = "none" | "paused" | "playing"

// What the window's zoom keys do: one step in or out, or back to 100%.
export type DesktopZoomStep = "in" | "out" | "reset"

export interface DesktopApp {
	readonly version: string
	// Unread chat messages, shown on the dock / taskbar.
	setBadge(count: number): void
	// What must not be dropped (lib/unloadGuard.ts holds) and audio playback: either keeps a hidden window's page alive,
	// and holds make quitting ask first.
	setUnloadHolds(count: number): void
	// Running work that must not slow down while the window is hidden or occluded (a video export): while above 0 the
	// window's timers and rendering are not background-throttled.
	setForegroundRenderingHolds(count: number): void
	setAudioPlaying(playing: boolean): void
	// The audio player's transport, for the macOS Controls menu and the tray.
	setMediaTransport(state: DesktopMediaTransport): void
	// The combo in effect per action ("" when unassigned), in the web keymap's notation.
	setMenuShortcuts(combos: Partial<Record<DesktopMenuAction, string>>): void
	// The shell's own text (menu, tray, main's notifications and dialogs) in the UI language; main keeps the last one
	// across restarts.
	setShellStrings(payload: DesktopShellStringsPayload): void
	// Subscribing tells main the page can take menu actions, so it delivers the ones clicked while the page loaded.
	onMenuAction(callback: (action: DesktopMenuAction) => void): () => void
	// A downloaded update waiting to be installed: calls back with its version right away when one is ready, and when
	// one becomes ready. Returns the unsubscribe.
	onUpdateReady(callback: (version: string) => void): () => void
	// Quits and installs the downloaded update, then relaunches. Without one, nothing happens. A quit the page's unload
	// guard cancels installs on the next quit instead.
	installUpdate(): void
	// Quits the app, through the same unload guard as the tray's Quit.
	quit(): void
	// The window's HTTP cache on disk, in bytes, and clearing it (with the compiled-code cache). Never site storage.
	browserCacheSize(): Promise<number>
	clearBrowserCache(): Promise<void>
}

// The window's own keys, which a desktop app has and a browser tab leaves to the browser: zoom, full screen, close.
export interface DesktopWindowControls {
	zoom(step: DesktopZoomStep): void
	toggleFullScreen(): void
	// Closes the window as its close button does (minimize to tray applies).
	close(): void
}

// The app lock. Main keeps the PIN (a salted slow hash in userData, encrypted like the session; never the PIN itself), the locked state and the
// failed-attempt backoff; the page only shows the lock screen and forwards what the user typed. PINs follow
// `desktopPinSchema` in `@filen/shared/desktopLock`.
export interface DesktopLockStatus {
	// A PIN is set.
	enabled: boolean
	// The page must show the lock screen and nothing else.
	locked: boolean
	// A PIN is set but cannot be read (the keychain is locked, the file is damaged), so it cannot be checked: the lock
	// screen offers trying again (`status()` reads it again) or signing out.
	unreadable: boolean
	// While wrong attempts are being backed off: when the next attempt is accepted (epoch ms).
	retryAt: number | null
	// No PIN is in effect, but one stored with secure storage waits for a run that has it again (this one has none): no
	// new PIN can be set over it until then, `set` is refused.
	waitingForSecureStorage: boolean
}

// A PIN check. A rejected one carries the backoff in effect; an attempt during it is rejected without being checked.
export type DesktopLockAttempt = { ok: true } | { ok: false; retryAt: number | null }

export interface DesktopLock {
	status(): Promise<DesktopLockStatus>
	// Calls back with every status main changes on its own (a lock while the window was hidden, a manual lock).
	onChanged(callback: (status: DesktopLockStatus) => void): () => void
	unlock(pin: string): Promise<DesktopLockAttempt>
	// Sets or changes the PIN; changing one needs the current PIN. Only while unlocked.
	set(pin: string, currentPin: string | null): Promise<DesktopLockAttempt>
	// Removes the PIN. Only while unlocked.
	clear(currentPin: string): Promise<DesktopLockAttempt>
	// Locks now; nothing without a PIN.
	lock(): void
	// A forgotten PIN: main removes the stored session and then the PIN. The page must sign out (wiping this device's
	// data) before it shows anything again.
	reset(): Promise<void>
}

// What `logs.export` did. The destination is picked in a save dialog main shows; the page never names a path.
export type DesktopLogsExport = "saved" | "canceled"

export interface DesktopLogs {
	// Bundles the shell's log with `webLog` (this page's own log, as text) into one redacted file.
	export(webLog: string): Promise<DesktopLogsExport>
}

export interface DesktopBridge {
	readonly platform: DesktopPlatform
	readonly session: DesktopSessionVault
	readonly prefs: DesktopPrefsStore
	readonly app: DesktopApp
	readonly lock: DesktopLock
	readonly logs: DesktopLogs
	readonly sync: DesktopSync
	readonly mounts: DesktopMounts
	readonly fileProvider: DesktopFileProvider
	readonly transfers: DesktopTransfers
	readonly drag: DesktopDrag
	readonly window: DesktopWindowControls
	setTitleBarColors(colors: TitleBarColors): void
	// Calls back with the current state right away when it is known, then on every change. Returns the unsubscribe.
	onWindowState(callback: (state: WindowState) => void): () => void
	// Shows and focuses the window (a clicked notification).
	showWindow(): void
	// The page saw the network come back (`online`): the sync engine's socket reconnects now instead of waiting out
	// its backoff.
	networkOnline(): void
}

// Directory sync. Pair ids are the engine's ids as decimal strings; a pair the engine does not hold yet (its local
// directory is missing, or the engine cannot sync its remote directory) has no engine id.

export type DesktopSyncMode = "twoWay" | "localToRemote" | "remoteToLocal" | "localBackup" | "remoteBackup"

// The native host that runs the sync engine. `retryAt` is epoch ms.
export type DesktopSyncHostState =
	| { state: "off" }
	| { state: "starting" }
	| { state: "running" }
	| { state: "restarting"; retryAt: number }
	| { state: "failed"; reason: "crashLoop" | "addonMissing" | "baselineInUse" | "keychainLocked" }

// `preparing`: a pair moved from the previous app, waiting for the cloud directory to be read before it starts.
// `waitingForCloud`: a pass waits for the cloud directory's listing; `indexing`: a pass reads the local directory;
// `offline`: the last pass could not reach the server.
export type DesktopSyncPhase =
	| "idle"
	| "syncing"
	| "paused"
	| "preparing"
	| "review"
	| "waitingForRoot"
	| "unsupported"
	| "error"
	| "waitingForCloud"
	| "indexing"
	| "offline"

// Why the engine refused for good a pair it had to add (a migrated one, or one a baseline reset lost): the local
// directory cannot be a root, the cloud directory is gone, or the pair overlaps another one on this device or in the
// cloud, or another pair has the same directories. `refusedWholeDrive`: a migrated pair of the whole drive overlaps the
// other pairs, so it is never started. The pair is kept (not synced) until the notice is dismissed, which removes it.
// With `refusedLocalRoot`, the pair's `rootProblem` says why.
export type DesktopSyncNotice =
	| "refusedLocalRoot"
	| "refusedRemoteMissing"
	| "refusedLocalOverlap"
	| "refusedRemoteOverlap"
	| "refusedWholeDrive"
	| "refusedModeConflict"

// The sync locale's key for each notice: filen-web shows it, the desktop e2e harness finds it by that text.
export const SYNC_NOTICE_KEY = {
	refusedLocalRoot: "noticeRefusedLocalRoot",
	refusedRemoteMissing: "noticeRefusedRemoteMissing",
	refusedLocalOverlap: "noticeRefusedLocalOverlap",
	refusedRemoteOverlap: "noticeRefusedRemoteOverlap",
	refusedWholeDrive: "noticeRefusedWholeDrive",
	refusedModeConflict: "noticeRefusedModeConflict"
} as const satisfies Record<DesktopSyncNotice, string>

// Why a pair moved from the previous app waits (preparing) for the user: its root .filenignore cannot be written or
// read as text, it syncs the whole drive (started only on request), or the cloud directory's listing is slow.
export type DesktopSyncHold = "ruleFileUnwritable" | "ruleFileUndecodable" | "driveRoot" | "cloudListingSlow"

// The holds that wait for the user; a slow cloud listing clears by itself.
export const SYNC_ATTENTION_HOLDS: ReadonlySet<DesktopSyncHold> = new Set(["ruleFileUnwritable", "ruleFileUndecodable", "driveRoot"])

// What a hold offers: `retry` tries again now, `startAnyway` starts a drive-root pair.
export type DesktopSyncHoldAction = "retry" | "startAnyway"

// Told once, dismissed for good: the pair now keeps replaced and deleted local files in its bin.
export type DesktopSyncInfoNotice = "localTrashNowOn"

// Why a pass held back part of its work: a side out of room, the server out of reach, or its certificate not
// verified (`certificateUnverified`: an intercepting proxy, or a CA the system does not trust).
export type DesktopSyncHalt = "localStorageFull" | "remoteStorageFull" | "offline" | "certificateUnverified"

// What a pass does before it starts: waits for the cloud listing, or reads the local directory. The "to hash" figures
// grow as the read goes.
export type DesktopSyncStage =
	| { kind: "waitingForCloud" }
	| { kind: "indexing"; entries: number; filesToHash: number; bytesToHash: number; filesHashed: number; bytesHashed: number }

// Pairs of the previous app that could not be read, and duplicates merged into one.
export interface DesktopSyncImportNote {
	dropped: number
	merged: number
}

// Why deletions were held back for approval.
// restoreUnfinished: a restore of held deletions has not landed yet, so what it would put back stays held.
export type DesktopSyncHeldReason =
	| "scanIncomplete"
	| "firstSyncWithDeletions"
	| "remoteUnconverged"
	| "remoteEmptied"
	| "exceededThreshold"
	| "restoreUnfinished"

// Why a pass applies nothing: two items on one side resolve to the same path (only a mode switch adopting the
// destination across such a pair refuses).
export type DesktopSyncRefusal = "remoteCollision" | "localCollision"

// What a dry run would do.
export interface DesktopSyncPlanSummary {
	actions: number
	uploadBytes: number
	downloadBytes: number
	heldDeletions: number
	heldReason: DesktopSyncHeldReason | null
	conflicts: number
	unsyncable: number
	ignored: number
	refused: DesktopSyncRefusal | null
}

// `overwrites`: a migrated one-way pair would replace a lot on its destination.
export type DesktopSyncReviewFinding = "uploads" | "downloads" | "conflicts" | "heldDeletions" | "refused" | "unconverged" | "overwrites"

// The sync locale's key for each review finding, as SYNC_NOTICE_KEY.
export const SYNC_FINDING_KEY = {
	uploads: "findingUploads",
	downloads: "findingDownloads",
	conflicts: "findingConflicts",
	heldDeletions: "findingHeldDeletions",
	refused: "findingRefused",
	unconverged: "findingUnconverged",
	overwrites: "findingOverwrites"
} as const satisfies Record<DesktopSyncReviewFinding, string>

// A pair kept paused until the user looked at what its first run would do. `summary` is null when the remote side
// never converged.
export interface DesktopSyncReview {
	reason: "migrated" | "baselineReset"
	findings: DesktopSyncReviewFinding[]
	summary: DesktopSyncPlanSummary | null
}

export interface DesktopSyncTransfer {
	relPath: string
	direction: "upload" | "download"
	bytes: number
	total: number
}

export interface DesktopSyncIssueCounts {
	conflicts: number
	heldDeletions: number
	unsyncable: number
	failed: number
}

export interface DesktopSyncPair {
	id: string
	name: string
	localRoot: string
	// The remote directory's uuid.
	remoteRoot: string
	mode: DesktopSyncMode
	paused: boolean
	phase: DesktopSyncPhase
	progress: { done: number; total: number } | null
	// The files moving now, newest first; at most 16.
	transfers: DesktopSyncTransfer[]
	// Epoch ms of the last completed pass this run saw.
	lastSyncedAt: number | null
	lastError: string | null
	issues: DesktopSyncIssueCounts
	// A watcher fell back to periodic full passes.
	degraded: { local: boolean; remote: boolean }
	stage: DesktopSyncStage | null
	halted: DesktopSyncHalt | null
	refused: DesktopSyncRefusal | null
	review: DesktopSyncReview | null
	notices: DesktopSyncNotice[]
	rootProblem: DesktopSyncRootProblem | null
	holds: DesktopSyncHold[]
	info: DesktopSyncInfoNotice[]
}

export interface DesktopSyncOverview {
	host: DesktopSyncHostState
	pairs: DesktopSyncPair[]
	importNote: DesktopSyncImportNote | null
}

export type DesktopSyncActivityKind =
	| "uploaded"
	| "downloaded"
	| "createdRemoteDirectory"
	| "createdLocalDirectory"
	| "trashedRemote"
	| "deletedLocal"
	| "movedRemote"
	| "movedLocal"
	| "binned"
	| "failed"
	| "conflict"
	| "deletionsHeld"
	| "passFailed"
	| "passCompleted"

export interface DesktopSyncActivity {
	seq: number
	pairId: string
	// Epoch ms.
	at: number
	kind: DesktopSyncActivityKind
	relPath?: string
	to?: string
	detail?: string
}

export type DesktopSyncPlanList = "actions" | "held" | "conflicts" | "unsyncable" | "ignored"

export type DesktopSyncNodeKind = "file" | "directory"

export type DesktopSyncActionKind =
	| "upload"
	| "download"
	| "createRemoteDirectory"
	| "createLocalDirectory"
	| "moveRemote"
	| "moveLocal"
	| "trashRemote"
	| "deleteLocal"
	| "adoptBaseline"

// `to` is a move's destination; `size` is null for directories and sizes neither side reported.
export interface DesktopSyncPlanAction {
	relPath: string
	kind: DesktopSyncActionKind
	to: string | null
	node: DesktopSyncNodeKind
	size: number | null
}

// Where a resolution put the copy that lost, at most one set: `quarantined` is the bin path keepRemote moved this
// device's differing copy to, `keptAs` the relative path keepBoth kept this device's copy at.
export interface DesktopSyncConflictResolved {
	quarantined: string | null
	keptAs: string | null
}

// A side is null where that side deleted the path.
export interface DesktopSyncConflict {
	relPath: string
	local: DesktopSyncNodeKind | null
	remote: DesktopSyncNodeKind | null
}

// A conflict the pair holds, with the resolutions that can clear it (in the order keepLocal, keepRemote, keepBoth):
// a backup mode's file-versus-directory conflict refuses the others as `resolutionRefused`.
export interface DesktopSyncHeldConflict extends DesktopSyncConflict {
	resolutions: DesktopSyncResolution[]
}

export type DesktopSyncUnsyncableReason =
	| "invalidName"
	| "repeatedFailure"
	| "remoteUndecodable"
	| "remoteInvalidName"
	| "remoteNameNotStorable"
	| "remoteBrokenParent"
	| "localAlias"
	| "localNameCollision"
	| "remoteNameCollision"
	| "remoteContentHashMismatch"

export interface DesktopSyncUnsyncable {
	relPath: string
	reason: DesktopSyncUnsyncableReason
	detail: string | null
}

// `dir` is the directory of the `.filenignore` holding `pattern` ("" is the pair's root), for level "file" only.
// `tracked`: the path was synced before and is no longer.
export interface DesktopSyncIgnored {
	relPath: string
	level: "default" | "user" | "file"
	dir: string | null
	pattern: string
	tracked: boolean
}

export type DesktopSyncPlanPage =
	| { list: "actions" | "held"; total: number; entries: DesktopSyncPlanAction[] }
	| { list: "conflicts"; total: number; entries: DesktopSyncConflict[] }
	| { list: "unsyncable"; total: number; entries: DesktopSyncUnsyncable[] }
	| { list: "ignored"; total: number; entries: DesktopSyncIgnored[] }

// A path the local read could not vouch for, which holds every deletion of the pass. `kind` is the I/O error kind
// (such as "PermissionDenied") of an unreadable one.
export interface DesktopSyncScanGap {
	relPath: string
	cause: "unreadable" | "changedDuringScan" | "nonUtf8Name"
	kind: string | null
}

// The deletions the last pass held back, the token that approves exactly them, and the paths that left its read
// incomplete (the first 100 of `gapsTotal`).
export interface DesktopSyncHeldDeletions {
	passToken: string | null
	reason: DesktopSyncHeldReason | null
	total: number
	entries: DesktopSyncPlanAction[]
	gaps: DesktopSyncScanGap[]
	gapsTotal: number
}

export type DesktopSyncErrorCode =
	| "hostUnavailable"
	| "timeout"
	| "unauthenticated"
	| "pairNotFound"
	| "planExpired"
	| "rootExpired"
	| "rootRefused"
	| "localRootMissing"
	| "remoteRootMissing"
	| "localRootInUse"
	| "localRootNested"
	| "localRootContains"
	| "remoteRootInUse"
	| "remoteRootNested"
	| "remoteRootContains"
	| "modeConflict"
	| "invalidIgnore"
	| "resolutionRefused"
	| "unknown"

// `pairId`: the other pair an overlap refusal names. `line`: the first ignore line that does not parse (1-based).
export interface DesktopSyncError {
	code: DesktopSyncErrorCode
	pairId?: string
	line?: number
	message?: string
}

// Why a chosen local directory cannot be a pair's root.
export type DesktopSyncRootProblem =
	| "notDirectory"
	| "notWritable"
	| "filesystemRoot"
	| "homeDirectory"
	| "appData"
	| "temporary"
	| "insidePair"
	| "containsPair"
	| "insideMount"
	| "containsMount"

// A root inside a directory another app syncs: allowed, but both apps then write the same files.
export type DesktopSyncRootWarning = "iCloud" | "cloudStorage" | "oneDrive"

// `id` stands for the chosen directory in a later addPair; the page never sends a path back.
export type DesktopSyncLocalRootChoice =
	| { status: "canceled" }
	| { status: "refused"; path: string; problem: DesktopSyncRootProblem }
	| { status: "ok"; id: string; path: string; name: string; warnings: DesktopSyncRootWarning[] }

// A sync call that can fail for a reason the page shows.
export type DesktopSyncResult<T> = { ok: true; value: T } | { ok: false; error: DesktopSyncError }

// A dry run held in the shell for paging; released by the page, on navigation, or after five minutes.
export interface DesktopSyncPlan {
	planId: string
	summary: DesktopSyncPlanSummary
}

// What happens to the changes a backup mode kept from the destination when the pair leaves that mode.
export type DesktopSyncBacklog = "propagate" | "adoptDestination"

export type DesktopSyncResolution = "keepLocal" | "keepRemote" | "keepBoth"

// A bulk resolution: `failed` paths are still conflicts.
export interface DesktopSyncResolvedConflicts {
	resolved: number
	failed: number
}

// `localRootId` is the id chooseLocalDirectory issued.
export interface DesktopSyncNewPair {
	localRootId: string
	remoteRoot: string
	mode: DesktopSyncMode
	name: string
}

export interface DesktopSyncEntries<T> {
	total: number
	entries: T[]
}

// The device-wide ignore rules the user wrote, and the engine's built-in ones (read-only).
export interface DesktopSyncUserIgnore {
	text: string
	defaults: string[]
}

// Pair ids are DesktopSyncPair.id. Overview and activity reach a page only while it listens; listening is what
// keeps the live updates flowing. A plan is null when the remote side has not caught up yet (try again later).
export interface DesktopSync {
	overview(): Promise<DesktopSyncOverview>
	// Calls back with the latest overview right away when one is known, then on every change.
	onOverview(callback: (overview: DesktopSyncOverview) => void): () => void
	// The pair's latest entries this run, newest first; at most 200.
	activity(pairId: string, limit: number): Promise<DesktopSyncActivity[]>
	onActivity(callback: (entries: DesktopSyncActivity[]) => void): () => void
	chooseLocalDirectory(): Promise<DesktopSyncLocalRootChoice>
	// Adds the pair paused and dry-runs it; startPair starts it, removePair cancels.
	addPair(pair: DesktopSyncNewPair): Promise<DesktopSyncResult<{ pairId: string; plan: DesktopSyncPlan | null }>>
	startPair(pairId: string): Promise<DesktopSyncResult<null>>
	// The files stay on both sides.
	removePair(pairId: string): Promise<DesktopSyncResult<null>>
	pausePair(pairId: string): Promise<DesktopSyncResult<null>>
	resumePair(pairId: string): Promise<DesktopSyncResult<null>>
	// `backlog` is required when leaving a backup mode and ignored otherwise.
	setMode(pairId: string, mode: DesktopSyncMode, backlog: DesktopSyncBacklog | null): Promise<DesktopSyncResult<null>>
	renamePair(pairId: string, name: string): Promise<DesktopSyncResult<null>>
	syncNow(pairId: string): Promise<DesktopSyncResult<null>>
	plan(pairId: string): Promise<DesktopSyncResult<DesktopSyncPlan | null>>
	// `limit` at most 200.
	planPage(planId: string, list: DesktopSyncPlanList, offset: number, limit: number): Promise<DesktopSyncResult<DesktopSyncPlanPage>>
	releasePlan(planId: string): Promise<void>
	conflicts(pairId: string, offset: number, limit: number): Promise<DesktopSyncResult<DesktopSyncEntries<DesktopSyncHeldConflict>>>
	resolveConflict(
		pairId: string,
		relPath: string,
		resolution: DesktopSyncResolution
	): Promise<DesktopSyncResult<DesktopSyncConflictResolved>>
	// Resolves at most `count` of the pair's conflicts, as listed when called, the same way one after another; the
	// overview's count drops as they go.
	resolveConflicts(
		pairId: string,
		resolution: DesktopSyncResolution,
		count: number
	): Promise<DesktopSyncResult<DesktopSyncResolvedConflicts>>
	heldDeletions(pairId: string): Promise<DesktopSyncResult<DesktopSyncHeldDeletions>>
	approveDeletions(pairId: string, passToken: string): Promise<DesktopSyncResult<null>>
	// The held deletions come undone instead: what they deleted is put back from the other side (or the pair's bin).
	restoreDeletions(pairId: string, passToken: string): Promise<DesktopSyncResult<null>>
	retryPath(pairId: string, relPath: string): Promise<DesktopSyncResult<null>>
	// Every path that kept failing is tried again on a pass that starts now.
	retryAll(pairId: string): Promise<DesktopSyncResult<null>>
	// From the last pass this run saw; null before one, when only a dry run (plan) lists them.
	unsyncablePaths(
		pairId: string,
		offset: number,
		limit: number
	): Promise<DesktopSyncResult<DesktopSyncEntries<DesktopSyncUnsyncable> | null>>
	ignoredPaths(pairId: string, offset: number, limit: number): Promise<DesktopSyncResult<DesktopSyncEntries<DesktopSyncIgnored>>>
	userIgnore(): Promise<DesktopSyncResult<DesktopSyncUserIgnore>>
	// Rejected as `invalidIgnore` with the first bad line.
	setUserIgnore(text: string): Promise<DesktopSyncResult<null>>
	// Opens the pair's directory, or its bin: where the engine moves replaced and deleted local files.
	reveal(pairId: string, target: "root" | "bin"): Promise<DesktopSyncResult<null>>
	dismissNotice(pairId: string, notice: DesktopSyncNotice): Promise<void>
	holdAction(pairId: string, action: DesktopSyncHoldAction): Promise<DesktopSyncResult<null>>
	dismissInfo(pairId: string, notice: DesktopSyncInfoNotice): Promise<void>
	dismissImportNote(): Promise<void>
	// Starts the native host again after it failed.
	retryHost(): void
	// A pair to show, from a clicked notification. Calls back with what was asked before subscribing.
	onOpenPair(callback: (pairId: string) => void): () => void
}

// Mounts: the network drive and the protocols the drive is served over, all run by one rclone in the native host.

export type DesktopServeProtocol = "webdav" | "s3" | "ftp" | "sftp" | "http" | "restic" | "nfs"

export type DesktopMountsRole = "drive" | DesktopServeProtocol

export type DesktopMountsRoleState = "off" | "starting" | "running" | "stopping" | "error"

// What mounts the drive: macFUSE when installed, else rclone's NFS mount (macOS); WinFsp; Linux fuse3. `installable`:
// the app ships an installer for the missing one.
export type DesktopFuseStatus =
	| { state: "ready"; provider: "macFuse" | "nfsMount" | "winFsp" | "fuse3" }
	| { state: "missing"; installable: boolean }

export type DesktopMountsErrorCode =
	| "hostUnavailable"
	| "fuseMissing"
	| "mountPointInvalid"
	| "mountPointNotEmpty"
	| "mountPointInUse"
	| "driveLetterInUse"
	| "portInUse"
	| "addressUnavailable"
	| "authRequired"
	| "uploadsPending"
	| "unsupportedProtocol"
	| "binaryInvalid"
	| "unauthenticated"
	| "timeout"
	| "mountPointExpired"
	| "credentialsInvalid"
	| "credentialsWeak"
	| "acknowledgementRequired"
	| "unknown"

export interface DesktopMountsError {
	code: DesktopMountsErrorCode
	message?: string
}

export type DesktopMountsResult<T> = { ok: true; value: T } | { ok: false; error: DesktopMountsError }

// Told once until dismissed, each for an old (3.x) setting this app could not keep: serve credentials were made anew
// (the old ones are gone or cannot be served); a server's old address cannot be listened on, so it is off; the old
// mount point cannot be used; the old client's caches still hold uploads, or uploads that failed; a server's
// certificate was made anew.
export type DesktopMountsNotice =
	| "credentialsRegenerated"
	| "addressInvalid"
	| "mountPointInvalid"
	| "legacyUploadsPending"
	| "legacyCacheErrored"
	| "certificateRegenerated"

// `mountPoint` (macOS, Linux) or `driveLetter` (Windows, "D".."Z").
export interface DesktopDrive {
	enabled: boolean
	state: DesktopMountsRoleState
	mountPoint: string | null
	driveLetter: string | null
	readOnly: boolean
	error: DesktopMountsError | null
}

// `address` is the IP the server listens on and `addressKind` how far it reaches; `httpsCapable` says whether the
// protocol can be served over https at all; `authenticated` is false for nfs only.
export interface DesktopServe {
	protocol: DesktopServeProtocol
	enabled: boolean
	state: DesktopMountsRoleState
	address: string
	addressKind: DesktopListenAddress["kind"]
	port: number
	httpsCapable: boolean
	https: boolean
	readOnly: boolean
	authenticated: boolean
	url: string | null
	tlsFingerprint: string | null
	error: DesktopMountsError | null
}

// The VFS cache every mount and server shares.
export interface DesktopVfsTuning {
	cacheMaxGiB: number
	cacheMinFreeGiB: number
	cacheMaxAgeHours: number
	dirCacheSeconds: number
}

export interface DesktopMountsOverview {
	host: DesktopSyncHostState
	// false: this build has no usable rclone, so nothing can be mounted or served (enabled roles report
	// `binaryInvalid`).
	available: boolean
	// null until it was looked up.
	fuse: DesktopFuseStatus | null
	// What Linux lacks to mount: the fuse3 package, or the FUSE device itself (a container or sandbox, which no
	// package fixes); null elsewhere and when nothing is missing.
	fuseGap: "fuse3" | "device" | null
	drive: DesktopDrive
	serves: DesktopServe[]
	// The protocols this platform offers.
	protocols: DesktopServeProtocol[]
	cache: { usedBytes: number; freeBytes: number; pendingUploads: number; erroredFiles: number }
	tuning: DesktopVfsTuning
	notices: DesktopMountsNotice[]
}

// `speed` in bytes per second.
export interface DesktopMountsStats {
	transfers: { name: string; bytes: number; total: number; speed: number }[]
	uploadsInProgress: number
	uploadsQueued: number
}

// Why a chosen directory cannot be the drive's mount point.
export type DesktopMountPointProblem =
	| "notDirectory"
	| "notEmpty"
	| "symlink"
	| "outsideHome"
	| "homeDirectory"
	| "appData"
	| "temporary"
	| "insidePair"
	| "containsPair"

// `id` stands for the chosen directory in a later setDrive; the page never sends a path back.
export type DesktopMountPointChoice =
	| { status: "canceled" }
	| { status: "refused"; path: string; problem: DesktopMountPointProblem }
	| { status: "ok"; id: string; path: string }

// The credentials a server takes: a user and password, or (s3) an access key pair. nfs takes none.
export type DesktopCredentialProtocol = Exclude<DesktopServeProtocol, "nfs">

export type DesktopServeCredentials =
	| { kind: "basic"; user: string; password: string }
	| { kind: "s3"; accessKeyId: string; secretAccessKey: string }

// An address a server can listen on: loopback, one LAN interface's IPv4 address, or every interface ("0.0.0.0").
export interface DesktopListenAddress {
	address: string
	kind: "loopback" | "lan" | "all"
	interface: string | null
}

// `mountPointId` is the id chooseMountPoint issued (macOS, Linux); `driveLetter` one of driveLetters() (Windows).
// Enabling without either takes the default: `~/Filen`, or the first free letter from X down.
export interface DesktopDrivePatch {
	enabled?: boolean
	mountPointId?: string
	driveLetter?: string
	readOnly?: boolean
}

// `address` is one of listenAddresses(). Moving a server off loopback turns https on unless the patch says otherwise.
// nfs runs only on loopback and only with `acknowledgeUnauthenticated`.
export interface DesktopServePatch {
	enabled?: boolean
	address?: string
	port?: number
	https?: boolean
	readOnly?: boolean
	acknowledgeUnauthenticated?: boolean
}

export type DesktopFuseInstall = "installed" | "rebootRequired" | "canceled" | "failed"

// The overview reaches a page only while it listens; the stats only while it listens to them, at most once a second
// and only while a role runs.
export interface DesktopMounts {
	overview(): Promise<DesktopMountsOverview>
	// Calls back with the latest overview right away when one is known, then on every change.
	onOverview(callback: (overview: DesktopMountsOverview) => void): () => void
	stats(): Promise<DesktopMountsStats>
	onStats(callback: (stats: DesktopMountsStats) => void): () => void
	chooseMountPoint(): Promise<DesktopMountPointChoice>
	// The letters free now; empty off Windows.
	driveLetters(): Promise<DesktopMountsResult<string[]>>
	setDrive(patch: DesktopDrivePatch): Promise<DesktopMountsResult<null>>
	listenAddresses(): Promise<DesktopListenAddress[]>
	setServe(protocol: DesktopServeProtocol, patch: DesktopServePatch): Promise<DesktopMountsResult<null>>
	// Made at random the first time they are asked for.
	credentials(protocol: DesktopCredentialProtocol): Promise<DesktopMountsResult<DesktopServeCredentials>>
	// Copies one part to the clipboard without the page holding it.
	copyCredential(protocol: DesktopCredentialProtocol, part: "user" | "secret"): Promise<DesktopMountsResult<null>>
	// Refused as `credentialsInvalid` or `credentialsWeak`.
	setCredentials(protocol: DesktopCredentialProtocol, credentials: DesktopServeCredentials): Promise<DesktopMountsResult<null>>
	regenerateCredentials(protocol: DesktopCredentialProtocol): Promise<DesktopMountsResult<null>>
	// Applies to every mount and server; running ones restart.
	setTuning(tuning: DesktopVfsTuning): Promise<DesktopMountsResult<null>>
	// Refused as `uploadsPending` while uploads are not finished; running roles stop for it and start again.
	clearCache(): Promise<DesktopMountsResult<null>>
	// Windows: installs the bundled WinFsp (asks for administrator rights); refused as `fuseMissing` where the app
	// ships no installer.
	installFuse(): Promise<DesktopMountsResult<DesktopFuseInstall>>
	// Opens the mounted drive.
	revealDrive(): Promise<DesktopMountsResult<null>>
	// Before signing out: true to go on. With uploads from the drive pending, the shell asks the user to wait or to
	// sign out anyway (the uploads then finish when this user signs in again).
	confirmSignOut(): Promise<boolean>
	dismissNotice(notice: DesktopMountsNotice): Promise<void>
	// Starts the native host again after it failed.
	retryHost(): void
}

// Filen in Finder: the macOS File Provider extension (macOS 14 and later), one domain for the signed-in user. Off a
// supported Mac `supported` is false and enabling is refused.
export interface DesktopFileProviderState {
	supported: boolean
	// Switched on for the signed-in user.
	enabled: boolean
	// A PIN app lock is set, which keeps the extension off.
	lockBlocked: boolean
	// macOS's own switch for the domain (System Settings); null while no domain of the user is registered.
	userEnabled: boolean | null
	// The app runs from a translocated copy or a disk image, where macOS refuses the extension; enabling is refused.
	translocated: boolean
}

export type DesktopFileProviderErrorCode =
	| "unsupported"
	| "appLocked"
	| "noSession"
	| "translocated"
	| "extensionMissing"
	| "notFound"
	| "timeout"
	| "unknown"

// `message`: the system's error domain and code, for the log only.
export interface DesktopFileProviderError {
	code: DesktopFileProviderErrorCode
	message?: string
}

export type DesktopFileProviderResult<T> = { ok: true; value: T } | { ok: false; error: DesktopFileProviderError }

export interface DesktopFileProvider {
	// Fixed for the app's run, so a page knows without asking.
	readonly supported: boolean
	state(): Promise<DesktopFileProviderState>
	// Refused where unsupported, while a PIN is set, when translocated, without a readable session, or when macOS
	// refuses the domain.
	enable(): Promise<DesktopFileProviderResult<DesktopFileProviderState>>
	// The extension forgets the session and the domain is removed with every file it replicated.
	disable(): Promise<DesktopFileProviderResult<DesktopFileProviderState>>
	// Opens the domain's directory in Finder; `notFound` while it is off or macOS has not made it yet.
	reveal(): Promise<DesktopFileProviderResult<null>>
	// Opens System Settings where extensions are switched on.
	openSettings(): Promise<void>
}

// Drive uploads and downloads the native host runs on real paths. SDK values cross as `stringifyEnvelope` strings
// (@filen/shared/session, bigint-safe) of the wasm shapes the page holds; main never reads them.

// stringifyEnvelope of a wasm-shaped SDK value; at most 8 KiB (a File or Dir is under 2 KiB).
export type DesktopSdkWire = string

// The variant the page already knows an item to be, so the host never has to tell untagged wasm unions apart.
export type DesktopSdkVariant =
	| "AnyFile.File"
	| "AnyFile.Shared"
	| "AnyFile.Linked"
	| "AnyNormalDir.Dir"
	| "AnyNormalDir.Root"
	| "AnyDirWithContext.Normal.Dir"
	| "AnyDirWithContext.Normal.Root"
	| "AnyDirWithContext.Shared.Dir"
	| "AnyDirWithContext.Shared.Root"
	| "AnyDirWithContext.Linked.Dir"
	| "AnyDirWithContext.Linked.Root"

export interface DesktopSdkRef {
	variant: DesktopSdkVariant
	value: DesktopSdkWire
}

export type DesktopTransferDirection = "upload" | "download"

export type DesktopTransferKind = "file" | "directory"

// "drag": a drag out of the window started it.
export type DesktopTransferOrigin = "page" | "drag"

export type DesktopTransferErrorCode =
	| "hostUnavailable"
	| "timeout"
	| "unauthenticated"
	| "interrupted"
	| "invalidItem"
	| "localMissing"
	| "localDenied"
	| "localFull"
	| "localInUse"
	| "storageFull"
	| "unknown"

// `kind`: the SDK's error kind; `message`: for the log only.
export interface DesktopTransferError {
	code: DesktopTransferErrorCode
	kind?: string
	message?: string
}

export type DesktopTransferResult<T> = { ok: true; value: T } | { ok: false; error: DesktopTransferError }

// A directory transfer's files; `failedBytes`: the size of the failed ones, so progress can still reach its total.
export interface DesktopTransferFiles {
	total: number
	done: number
	failed: number
	failedBytes: number
}

// `group`: the transfers one call started share it. `files`: null for a single file. `startedAt` is epoch ms.
// `revealable`: a finished download main can show or open (false for drag temp copies and uploads).
export interface DesktopTransfer {
	id: string
	direction: DesktopTransferDirection
	kind: DesktopTransferKind
	origin: DesktopTransferOrigin
	group: string
	name: string
	parentUuid: string | null
	size: number
	bytes: number
	files: DesktopTransferFiles | null
	paused: boolean
	startedAt: number
	revealable: boolean
}

export interface DesktopTransferProgress {
	id: string
	size: number
	bytes: number
	files: DesktopTransferFiles | null
}

// "completedWithErrors": a directory transfer that ended with failed or skipped entries.
export type DesktopTransferOutcome = "done" | "completedWithErrors" | "error" | "cancelled"

// `uploaded`: the File (file upload) or Dir (directory upload) the upload created.
export type DesktopTransferEvent =
	| { t: "snapshot"; transfers: DesktopTransfer[] }
	| { t: "added"; transfers: DesktopTransfer[] }
	| { t: "progress"; updates: DesktopTransferProgress[] }
	| { t: "paused"; ids: string[]; paused: boolean }
	| { t: "settled"; id: string; outcome: DesktopTransferOutcome; error?: DesktopTransferError; uploaded?: DesktopSdkWire }

export interface DesktopDownloadItem {
	kind: DesktopTransferKind
	ref: DesktopSdkRef
	name: string
	size: number
}

// `ref`: an AnyNormalDir.Dir or AnyNormalDir.Root.
export interface DesktopUploadParent {
	uuid: string
	ref: DesktopSdkRef
}

export type DesktopTransferStart = { status: "canceled" } | { status: "started"; ids: string[] }

// `skipped`: indexes of the given Files that have no local path.
export type DesktopUploadStart = { status: "canceled" } | { status: "started"; ids: string[]; skipped: number[] }

export type DesktopDownloadDirectoryChoice = { status: "canceled" } | { status: "chosen"; path: string }

export interface DesktopTransfers {
	// To the download directory pref when set, else a save dialog (one file) or a directory picker. `ask`: always the
	// directory picker ("Download to…").
	download(items: DesktopDownloadItem[], options?: { ask?: boolean }): Promise<DesktopTransferResult<DesktopTransferStart>>
	// Files the page holds (drops, web-input picks). A File whose path is a directory uploads as one directory (main
	// stats it). `asDirectory`: the Files are one webkitdirectory input's contents; the picked directory uploads as one.
	upload(
		files: File[],
		parent: DesktopUploadParent,
		options?: { asDirectory?: boolean }
	): Promise<DesktopTransferResult<DesktopUploadStart>>
	// Main's own open dialog, the picked paths straight to the host.
	pickUpload(kind: DesktopTransferKind, parent: DesktopUploadParent): Promise<DesktopTransferResult<DesktopTransferStart>>
	cancel(ids: string[]): void
	setPaused(ids: string[], paused: boolean): void
	// Calls back with a snapshot first, then with every change. Returns the unsubscribe.
	onEvents(callback: (event: DesktopTransferEvent) => void): () => void
	// Shows or opens a finished, revealable download.
	reveal(id: string): Promise<DesktopTransferResult<null>>
	open(id: string): Promise<DesktopTransferResult<null>>
	// Main's directory picker for the download directory pref; a chosen path is stored before this resolves.
	chooseDownloadDirectory(): Promise<DesktopDownloadDirectoryChoice>
}

// The drag image: a PNG of at most 640×160 CSS px, `scale` (at most 3) device pixels per CSS px.
export const DESKTOP_DRAG_IMAGE_LIMITS = { bytes: 2 * 1024 ** 2, width: 640, height: 160, scale: 3 } as const

export interface DesktopDragImage {
	png: Uint8Array
	width: number
	height: number
	scale: number
}

// Why a drag-out was refused. "tooLarge"/"tooMany": past a staged copy's 512 MiB / 2,000 entries (Linux) or past
// Windows' 10,000 descriptors; "pathTooLong": a Windows path past 259 UTF-16 units; "offline": decided by the page's
// own online state, never sent by main; "unavailable": no addon, no host, or signed out.
export type DesktopDragRefusal =
	| { reason: "tooLarge"; bytes: number; limit: number }
	| { reason: "tooMany"; entries: number; limit: number }
	| { reason: "pathTooLong"; path: string }
	| { reason: "offline" }
	| { reason: "unavailable" }

export type DesktopDragPrepared = { id: string } | { refused: DesktopDragRefusal }

// "ended": the OS drag finished without telling drop from cancel (Linux). "notReady": the items are still being staged.
export type DesktopDragOutcome = "dropped" | "cancelled" | "ended" | "notReady" | "failed"

export type DesktopDragState =
	| { id: string; state: "staging"; bytes: number; total: number }
	| { id: string; state: "ready" }
	| { id: string; state: "ended"; outcome: DesktopDragOutcome }

// Drive items dragged out of the window onto the OS. The page prepares once the pointer leaves the window, then begins
// the OS drag with the id; an id answers only the page that prepared it.
export interface DesktopDrag {
	prepare(request: { items: DesktopDownloadItem[] }): Promise<DesktopDragPrepared>
	begin(request: { id: string; image: DesktopDragImage }): Promise<DesktopDragOutcome>
	// An unbegun id ends with "cancelled"; a begun one is the OS's to end.
	release(id: string): void
	// Calls back with the latest state of every live id first, then on every change. Returns the unsubscribe.
	onState(callback: (state: DesktopDragState) => void): () => void
}
