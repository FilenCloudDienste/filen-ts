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
	readonly mounts: DesktopMounts
	readonly fileProvider: DesktopFileProvider
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

// `preparing`: a pair moved from the previous app, waiting for the cloud directory to be read before it starts.
export type DesktopSyncPhase = "idle" | "syncing" | "paused" | "preparing" | "review" | "waitingForRoot" | "unsupported" | "error"

// Why the engine refused for good a pair it had to add (a migrated one, or one a baseline reset lost): the local
// directory cannot be a root, the cloud directory is gone, or the pair overlaps another one on this device or in the
// cloud. The pair is kept (not synced) until the notice is dismissed, which removes it.
export type DesktopSyncNotice = "refusedLocalRoot" | "refusedRemoteMissing" | "refusedLocalOverlap" | "refusedRemoteOverlap"

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

// `overwrites`: a migrated one-way pair would replace a lot on its destination.
export type DesktopSyncReviewFinding = "uploads" | "downloads" | "conflicts" | "heldDeletions" | "refused" | "unconverged" | "overwrites"

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
	// Opens the pair's directory, or its bin: where the engine moves replaced and deleted local files.
	reveal(pairId: string, target: "root" | "bin"): Promise<DesktopSyncResult<null>>
	dismissNotice(pairId: string, notice: DesktopSyncNotice): Promise<void>
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
