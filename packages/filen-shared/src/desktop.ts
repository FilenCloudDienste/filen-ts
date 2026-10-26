// The contract between the Filen web app and the desktop shell's preload, exposed as `window.desktop`.
// Types only: the browser build pays nothing for it, and an absent `window.desktop` means a plain browser.

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

// The SDK session kept by the shell in the OS keychain-backed vault instead of web storage. `blob` is the session as
// the web's envelope JSON (bigint-safe); the shell checks its shape and never reads the keys.
export interface DesktopSessionVault {
	// null only when no session is stored. Rejects when one is stored but cannot be read (locked keychain, changed
	// desktop environment): that is not a sign-out, so the caller must not clear anything.
	get(): Promise<string | null>
	set(blob: string): Promise<void>
	clear(): Promise<void>
	// The stored session just passed its first authed request of this page. The shell uses it once, to retire what
	// the old desktop client left behind after its account was migrated.
	markVerified(): void
	// The server rejected the stored session (a revoked API key) while the shell used it for sync: the shell already
	// removed it, so the page must sign out. Calls back right away when that happened before subscribing.
	onRevoked(callback: () => void): () => void
}

// Shell preferences, kept by main in userData. `launchAtLogin` starts the app hidden; `notifications` also keeps the
// hidden window's page alive, since it owns the chat socket the notifications come from.
export interface DesktopPrefs {
	minimizeToTray: boolean
	startMinimized: boolean
	launchAtLogin: boolean
	notifications: boolean
}

export interface DesktopPrefsStore {
	get(): Promise<DesktopPrefs>
	// Resolves with the prefs now in effect.
	set(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs>
}

// The web keymap actions the macOS menu offers. Main shows each with the combo the web reports and sends the id back
// when the item is clicked; the web stays the only key dispatcher.
export type DesktopMenuAction = "app.openSettings" | "app.openShortcuts" | "app.toggleTheme" | "app.toggleAssistant" | "app.openTransfers"

export interface DesktopApp {
	readonly version: string
	// Unread chat messages, shown on the dock / taskbar.
	setBadge(count: number): void
	// What must not be dropped (lib/unloadGuard.ts holds) and audio playback: either keeps a hidden window's page alive,
	// and holds make quitting ask first.
	setUnloadHolds(count: number): void
	setAudioPlaying(playing: boolean): void
	// The combo in effect per action ("" when unassigned), in the web keymap's notation.
	setMenuShortcuts(combos: Partial<Record<DesktopMenuAction, string>>): void
	// Subscribing tells main the page can take menu actions, so it delivers the ones clicked while the page loaded.
	onMenuAction(callback: (action: DesktopMenuAction) => void): () => void
	// A downloaded update waiting to be installed: calls back with its version right away when one is ready, and when
	// one becomes ready. Returns the unsubscribe.
	onUpdateReady(callback: (version: string) => void): () => void
	// Quits and installs the downloaded update, then relaunches. Without one, nothing happens. A quit the page's unload
	// guard cancels installs on the next quit instead.
	installUpdate(): void
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
	setTitleBarColors(colors: TitleBarColors): void
	// Calls back with the current state right away when it is known, then on every change. Returns the unsubscribe.
	onWindowState(callback: (state: WindowState) => void): () => void
	// Shows and focuses the window (a clicked notification).
	showWindow(): void
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

export type DesktopSyncPhase = "idle" | "syncing" | "paused" | "review" | "waitingForRoot" | "unsupported" | "error"

// Told once per pair until dismissed: the old client's local trash is no longer used; the engine cannot sync an
// account's root directory yet.
export type DesktopSyncNotice = "localTrashDropped" | "accountRootUnsupported"

// Why deletions were held back for approval.
export type DesktopSyncHeldReason =
	"scanIncomplete" | "firstSyncWithDeletions" | "remoteUnconverged" | "remoteEmptied" | "exceededThreshold"

// Why a pass applies nothing: two items on one side resolve to the same path.
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

export type DesktopSyncReviewFinding =
	"uploads" | "downloads" | "conflicts" | "heldDeletions" | "refused" | "newlySynced" | "unconverged" | "dotFilesPerPair"

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
	transfers: DesktopSyncTransfer[]
	// Epoch ms of the last completed pass this run saw.
	lastSyncedAt: number | null
	lastError: string | null
	issues: DesktopSyncIssueCounts
	// A watcher fell back to periodic full passes.
	degraded: { local: boolean; remote: boolean }
	review: DesktopSyncReview | null
	notices: DesktopSyncNotice[]
}

export interface DesktopSyncOverview {
	host: DesktopSyncHostState
	pairs: DesktopSyncPair[]
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
	| "quarantined"
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

// A side is null where that side deleted the path.
export interface DesktopSyncConflict {
	relPath: string
	local: DesktopSyncNodeKind | null
	remote: DesktopSyncNodeKind | null
}

export type DesktopSyncUnsyncableReason =
	"invalidName" | "repeatedFailure" | "remoteUndecodable" | "remoteInvalidName" | "remoteBrokenParent" | "localAlias"

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

// The deletions the last pass held back, and the token that approves exactly them.
export interface DesktopSyncHeldDeletions {
	passToken: string | null
	reason: DesktopSyncHeldReason | null
	total: number
	entries: DesktopSyncPlanAction[]
}

export type DesktopSyncErrorCode =
	| "hostUnavailable"
	| "timeout"
	| "unauthenticated"
	| "pairNotFound"
	| "planExpired"
	| "rootExpired"
	| "rootRefused"
	| "accountRoot"
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
	conflicts(pairId: string, offset: number, limit: number): Promise<DesktopSyncResult<DesktopSyncEntries<DesktopSyncConflict>>>
	// Resolves with where keepBoth put the local copy.
	resolveConflict(pairId: string, relPath: string, resolution: DesktopSyncResolution): Promise<DesktopSyncResult<string | null>>
	heldDeletions(pairId: string): Promise<DesktopSyncResult<DesktopSyncHeldDeletions>>
	approveDeletions(pairId: string, passToken: string): Promise<DesktopSyncResult<null>>
	retryPath(pairId: string, relPath: string): Promise<DesktopSyncResult<null>>
	ignoredPaths(pairId: string, offset: number, limit: number): Promise<DesktopSyncResult<DesktopSyncEntries<DesktopSyncIgnored>>>
	userIgnore(): Promise<DesktopSyncResult<DesktopSyncUserIgnore>>
	// Rejected as `invalidIgnore` with the first bad line.
	setUserIgnore(text: string): Promise<DesktopSyncResult<null>>
	// Opens the pair's directory, or the directory the engine moves replaced and deleted local files to.
	reveal(pairId: string, target: "root" | "quarantine"): Promise<DesktopSyncResult<null>>
	dismissNotice(pairId: string, notice: DesktopSyncNotice): Promise<void>
	// Starts the native host again after it failed.
	retryHost(): void
	// A pair to show, from a clicked notification. Calls back with what was asked before subscribing.
	onOpenPair(callback: (pairId: string) => void): () => void
}
