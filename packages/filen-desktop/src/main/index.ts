import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	type IpcMainInvokeEvent,
	Menu,
	type NativeImage,
	nativeImage,
	nativeTheme,
	Notification,
	powerMonitor,
	protocol,
	safeStorage,
	session,
	shell,
	Tray,
	utilityProcess,
	type WebFrameMain
} from "electron"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import { type } from "arktype"
import path from "node:path"
import type { DesktopLogsExport, DesktopMenuAction, DesktopPlatform, DesktopSyncHostState, WindowState } from "@filen/shared/desktop"
import { desktopPinSchema } from "@filen/shared/desktopLock"
import { CHANNELS } from "../shared/channels.ts"
import type { NativeAggregate } from "../shared/nativeProtocol.ts"
import { type AppLock, hiddenLockDue, LOCK_AFTER_HIDDEN_MS, loadAppLock } from "./appLock.ts"
import { atomicFile, codedError, errorCode } from "./atomicFile.ts"
import { autostartFile, setAutostart } from "./autostart.ts"
import { BADGE_DOT_SIZE, badgeDotBitmap } from "./badge.ts"
import { parseHeaders } from "./headers.ts"
import { createFileLog } from "./fileLog.ts"
import { closeAction, HIDDEN_ARG, IDLE_DESTROY_DELAY_MS, keepsRendererAlive, startsHidden } from "./lifecycle.ts"
import { READ_SCRIPT, WIPE_SCRIPT } from "./legacyData.ts"
import { LEGACY_SCHEME, runInLegacyOrigin } from "./legacyOrigin.ts"
import { isMenuAction, type MenuShortcuts, menuTemplate } from "./menu.ts"
import { createMigration } from "./migration.ts"
import { addonPath } from "./native/addonPath.ts"
import { createNativeSupervisor } from "./native/supervisor.ts"
import { classifyNavigation, isTrustedSender } from "./navigation.ts"
import { isPermissionAllowed } from "./permissions.ts"
import { DEFAULT_PREFS, loadPrefs, prefsPatchSchema, type PrefsStore } from "./prefs.ts"
import { registerAppProtocol } from "./serve.ts"
import { redact } from "./redact.ts"
import { createSessionVault, isSessionBlob, lazyCipher, vaultMode, type VaultCipher } from "./sessionVault.ts"
import { registerSyncIpc } from "./sync/ipc.ts"
import { createRootTokens } from "./sync/localRoot.ts"
import { createSyncService } from "./sync/service.ts"
import { loadSyncStore, type SyncStore } from "./sync/store.ts"
import { attentionPair, attentionTransitions, trayIconFile, trayState, type TrayState, traySyncStatus, trayTooltip } from "./sync/tray.ts"
import { startUpdater, testUpdateFeed, type Updater } from "./updater.ts"
import { drawsOwnBorder, initialColors, titleBarColorsSchema, windowOptions } from "./window.ts"

// Payloads from the renderer are untrusted input.
const countSchema = type("0 <= number.integer < 1000000")
const audioPlayingSchema = type("boolean")
const menuShortcutsSchema = type({ "[string]": "string <= 64" })
const pinChangeSchema = type([desktopPinSchema, desktopPinSchema.or("null")])
// The page's own log ring holds a few hundred lines; this only stops an unbounded payload.
const webLogSchema = type("string <= 16777216")

const SCHEME = "filen"
const APP_ORIGIN = `${SCHEME}://app`
const PLATFORM = process.platform as DesktopPlatform

// The old client's userData lives under the package name; pinning it keeps it for the migration and the keychain.
// Unpackaged runs get their own directory so development never touches a real installation.
app.setPath("userData", path.join(app.getPath("appData"), app.isPackaged ? "@filen/desktop" : "@filen/desktop-dev"))
app.setName("Filen")
// Windows shows notifications and groups the taskbar button under the installer shortcut's id, electron-builder's appId.
if (process.platform === "win32") {
	app.setAppUserModelId("io.filen.desktop")
}

const SCHEME_PRIVILEGES = {
	standard: true,
	secure: true,
	supportFetchAPI: true,
	corsEnabled: true,
	stream: true,
	codeCache: true,
	allowServiceWorkers: true
}

// One call (Electron takes only one). The old client's scheme is the migration's way into its localStorage, with the
// privileges it had (its src/lib/serve.ts), so the origin and its storage are the same.
protocol.registerSchemesAsPrivileged([
	{ scheme: SCHEME, privileges: SCHEME_PRIVILEGES },
	{ scheme: LEGACY_SCHEME, privileges: SCHEME_PRIVILEGES }
])

// The shell's log, kept beside the other userData files (development has its own userData, so its own log).
const fileLog = createFileLog(path.join(app.getPath("userData"), "logs"))

function info(message: string): void {
	console.info(message)
	fileLog.write("info", message)
}

function warn(message: string): void {
	console.warn(message)
	fileLog.write("warn", message)
}

info(`Filen ${app.getVersion()} starting (Electron ${process.versions.electron}, ${PLATFORM} ${process.arch} ${os.release()})`)

// Packaged builds carry the web build as a resource; development serves filen-web's own dist or FILEN_DESKTOP_WEB_DIST.
const webDist = app.isPackaged
	? path.join(process.resourcesPath, "web")
	: path.resolve(process.env["FILEN_DESKTOP_WEB_DIST"] ?? path.join(app.getAppPath(), "../filen-web/dist"))

// Probed on first use, after app ready: safeStorage reports nothing useful before it.
async function sessionCipher(): Promise<VaultCipher | null> {
	const backend = PLATFORM === "linux" ? safeStorage.getSelectedStorageBackend() : ""

	if (vaultMode(PLATFORM, backend, await safeStorage.isAsyncEncryptionAvailable()) === "memory") {
		warn(`session vault: no secure storage (${backend || "unavailable"}); keeping the session in memory only`)

		return null
	}

	return {
		encrypt: plain => safeStorage.encryptStringAsync(plain),
		decrypt: encrypted => safeStorage.decryptStringAsync(encrypted)
	}
}

// Shared by the session vault and the app lock's PIN record. safeStorage works only after ready.
const vaultCipher = lazyCipher(async () => {
	await app.whenReady()

	return sessionCipher()
})
const sessionVault = createSessionVault(vaultCipher, atomicFile(path.join(app.getPath("userData"), "session.vault")), warn)

// Read before ready; the window and every pref-dependent decision come after ready, once this has settled.
const prefsLoading = loadPrefs(atomicFile(path.join(app.getPath("userData"), "prefs.json")), warn)
let prefs: PrefsStore | null = null

// Read from before ready like the prefs (decrypting waits for ready); no window is created before it has settled.
const appLockLoading = loadAppLock(atomicFile(path.join(app.getPath("userData"), "lock.vault")), vaultCipher, warn)
let appLock: AppLock | null = null

const userDataPath = app.getPath("userData")
const migrationStash = atomicFile(path.join(userDataPath, "migration.stash"))

// The one-time import from the old client. Runs after ready and before the first window; see migration.ts.
const migration = createMigration({
	marker: atomicFile(path.join(userDataPath, "migration.json")),
	legacyProfile: async () => {
		try {
			return (await stat(path.join(userDataPath, "Local Storage", "leveldb"))).isDirectory()
		} catch {
			return false
		}
	},
	readLegacy: () => runInLegacyOrigin(READ_SCRIPT),
	readOptions: async () => (await atomicFile(path.join(userDataPath, "options.v1.json")).read())?.toString("utf8") ?? null,
	wipeLegacy: async () => {
		if ((await runInLegacyOrigin(WIPE_SCRIPT)) !== true) {
			throw codedError("indexeddb not deleted")
		}
	},
	// The old client's generated rclone remote: the account's keys, merely obscured.
	removeRcloneConfig: () => rm(path.join(userDataPath, "rclone", "rclone.conf"), { force: true }),
	purgeLegacyStores: async () => {
		const indexedDb = path.join(userDataPath, "IndexedDB")
		const oldOrigin = (await readdir(indexedDb).catch(() => [])).filter(name => name.startsWith("filendesktop_bundle_0."))

		await Promise.all(oldOrigin.map(name => rm(path.join(indexedDb, name), { recursive: true, force: true })))
		await rm(path.join(userDataPath, "Local Storage"), { recursive: true, force: true })
	},
	vault: sessionVault,
	lock: {
		enabled: () => appLock?.status().enabled ?? true,
		set: async pin => (await (await appLockLoading).set(pin, null)).ok
	},
	prefs: { set: async patch => (await prefsLoading).set(patch) },
	launchesAtLogin: () =>
		PLATFORM !== "linux" && app.getLoginItemSettings(PLATFORM === "win32" ? { args: [HIDDEN_ARG] } : undefined).openAtLogin,
	applyLaunchAtLogin: enabled => applyLaunchAtLogin(enabled),
	writeStash: async text => {
		const cipher = await vaultCipher()

		// Like the session: no secure storage, nothing on disk.
		if (cipher === null) {
			warn("migration: no secure storage; the stash is not kept")

			return
		}

		await migrationStash.write(await cipher.encrypt(text))
	},
	now: Date.now,
	info,
	warn
})

// Sync: one engine directory per user, never under the old client's userData/sync.
const syncEngineRoot = path.join(userDataPath, "sync-engine")
const syncStores = new Map<string, Promise<SyncStore>>()

async function engineDir(userId: string): Promise<string> {
	const dir = path.join(syncEngineRoot, userId)

	await mkdir(dir, { recursive: true, mode: 0o700 })

	return dir
}

// Read once per user; the directory is created by the first write, so a user without sync gets none.
function syncStoreFor(userId: string): Promise<SyncStore> {
	let store = syncStores.get(userId)

	if (store === undefined) {
		const file = atomicFile(path.join(syncEngineRoot, userId, "shell.json"))

		store = loadSyncStore(
			{
				...file,
				write: async data => {
					await engineDir(userId)
					await file.write(data)
				}
			},
			warn
		)
		syncStores.set(userId, store)
	}

	return store
}

const nativeSupervisor = createNativeSupervisor({
	fork: () => utilityProcess.fork(path.join(import.meta.dirname, "native.js"), [], { serviceName: "Filen Sync", stdio: "pipe" }),
	vault: sessionVault,
	addonPath: () =>
		addonPath({
			packaged: app.isPackaged,
			resourcesPath: process.resourcesPath,
			env: process.env,
			appPath: app.getAppPath(),
			platform: process.platform,
			arch: process.arch,
			exists: existsSync
		}),
	dirFor: engineDir,
	demand: async userId => (await syncStoreFor(userId)).hasPairs(),
	log: { info, warn },
	onMessage: (message, userId) => {
		if (message.t === "aggregate") {
			syncAggregate = message.state
			applySyncTray()
		} else if (message.t === "activity") {
			syncAttentionPair = attentionPair(message.entries, syncAttentionPair)
		}

		syncService.nativeEvent(message, userId).catch((error: unknown) => {
			warn(`sync: ${message.t} not applied: ${errorCode(error)}`)
		})
	},
	onState: state => {
		if (state.state !== "running") {
			syncAggregate = "idle"
		}

		syncService.hostChanged(state)
		applySyncTray()
	},
	onRevoked: () => {
		info("session revoked by the server; signed out")
		syncService.signedOut()
		mainWindow?.webContents.send(CHANNELS.sessionRevoked)
	}
})

const syncService = createSyncService({
	supervisor: nativeSupervisor,
	storeFor: syncStoreFor,
	tokens: createRootTokens(Date.now),
	dialogs: {
		showOpenDialog: options => (mainWindow === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(mainWindow, options)),
		rootContext: () => ({
			platform: process.platform,
			home: app.getPath("home"),
			appData: [userDataPath, app.getPath("appData")],
			temporary: [app.getPath("temp"), os.tmpdir()],
			oneDrive:
				PLATFORM === "win32"
					? ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].flatMap(name => {
							const dir = process.env[name]

							return dir === undefined || dir.length === 0 ? [] : [dir]
						})
					: []
		})
	},
	shell: { openPath: target => shell.openPath(target) },
	now: Date.now
})

// The engine's own work keeps going; only its data and its process go with the session.
function syncSignedOut(): void {
	nativeSupervisor.signedOut()
	syncService.signedOut()
}

function isLocked(): boolean {
	return appLock?.status().locked ?? true
}

// Only a packaged app has a feed (electron-builder's app-update.yml) and an install to replace.
let updater: Updater | null = null

function currentPrefs() {
	return prefs?.get() ?? DEFAULT_PREFS
}

let mainWindow: BrowserWindow | null = null
let quitting = false
// Set once the update installer is launched: the page's unload confirm was answered for it (or there was nothing to
// confirm), and a cancel could not stop the installer anyway.
let installingUpdate = false

// Restart into the downloaded update: the page's prompt, or right away under the install tests' feed.
function installUpdateNow(): void {
	if (updater === null || installingUpdate) {
		return
	}

	// The window's close handler would otherwise only hide it, and the install waits for every window to close.
	quitting = true
	installingUpdate = true

	if (!updater.install()) {
		warn("updater: the update could not be installed")
		quitting = false
		installingUpdate = false
	}
}
// The window needs the app protocol and the migration; a show asked for before (activate, second-instance, the
// tray) is remembered and honoured once startup finished.
let started = false
let showRequested = false

// What the current page reported; a new page starts from nothing.
let unloadHolds = 0
let audioPlaying = false
// The page listens for menu actions; until then clicked ones wait here.
let menuReady = false
let pendingMenuActions: DesktopMenuAction[] = []

function resetPageState(): void {
	unloadHolds = 0
	audioPlaying = false
	menuReady = false
	scheduleIdleDestroy()
}

function showWindow(): void {
	if (!started) {
		showRequested = true

		return
	}

	// Before anything shows again, so a window hidden through a sleep never shows its page unlocked.
	lockIfHiddenTooLong()

	if (mainWindow === null) {
		createWindow()

		return
	}

	if (mainWindow.isMinimized()) {
		mainWindow.restore()
	}

	mainWindow.show()
	mainWindow.focus()
}

function openExternally(url: string): void {
	if (classifyNavigation(url, APP_ORIGIN) === "external") {
		void shell.openExternal(url)
	}
}

const DRAWS_OWN_BORDER = drawsOwnBorder(PLATFORM, process.getSystemVersion())

// The page keys its chrome off this state (the Windows 10 border, the macOS traffic-light inset in fullscreen).
// Windows has no snap event, so resize re-reads it; unchanged states are not resent.
function trackWindowState(window: BrowserWindow): void {
	let sent = ""

	const send = () => {
		const state: WindowState = {
			maximized: window.isMaximized(),
			fullScreen: window.isFullScreen(),
			snapped: PLATFORM === "win32" && window.snapped,
			drawsBorder: DRAWS_OWN_BORDER
		}
		const serialized = JSON.stringify(state)

		if (serialized !== sent) {
			sent = serialized
			window.webContents.send(CHANNELS.windowState, state)
		}
	}

	window.webContents.on("dom-ready", () => {
		sent = ""
		send()
	})

	for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "resize"] as const) {
		window.on(event as "maximize", send)
	}
}

let idleTimer: NodeJS.Timeout | undefined

// D14: a hidden window gives its renderer back after a while, unless the page still has work that must not be dropped.
function scheduleIdleDestroy(): void {
	clearTimeout(idleTimer)
	idleTimer = undefined

	const window = mainWindow
	const idle = () =>
		!window?.isVisible() && !keepsRendererAlive({ unloadHolds, audioPlaying, notifications: currentPrefs().notifications })

	if (window === null || !idle()) {
		return
	}

	idleTimer = setTimeout(() => {
		idleTimer = undefined

		if (mainWindow === window && idle()) {
			window.destroy()
		}
	}, IDLE_DESTROY_DELAY_MS)
}

// Every lock change the page did not just ask for reaches it here; the menu and tray offer "Lock" only while unlocked.
function lockChanged(): void {
	if (appLock !== null) {
		mainWindow?.webContents.send(CHANNELS.lockChanged, appLock.status())
	}

	applyMenu()
	applyTrayMenu()
}

function lockNow(): void {
	if (appLock?.lock() === true) {
		info("app lock: locked")
		lockChanged()
	}
}

let lockTimer: NodeJS.Timeout | undefined
// When the window went out of sight (hidden, minimized or destroyed while hidden); null while it is visible.
let hiddenAt: number | null = null

// A window hidden (or minimized) for a while locks, whether or not its page is still alive by then. The timer covers
// an awake machine; it stops while the machine sleeps, so every way back (showing, resume, screen unlock) also
// compares the clock.
function windowHidden(): void {
	hiddenAt ??= Date.now()
	clearTimeout(lockTimer)
	lockTimer = setTimeout(lockNow, Math.max(0, hiddenAt + LOCK_AFTER_HIDDEN_MS - Date.now()))
}

function windowShown(): void {
	lockIfHiddenTooLong()
	hiddenAt = null
	clearTimeout(lockTimer)
	lockTimer = undefined
}

function lockIfHiddenTooLong(): void {
	if (hiddenLockDue(hiddenAt, Date.now())) {
		lockNow()
	}
}

function hideWindow(window: BrowserWindow): void {
	// Hiding a fullscreen window leaves an empty fullscreen Space behind on macOS.
	if (window.isFullScreen()) {
		window.once("leave-full-screen", () => window.hide())
		window.setFullScreen(false)
	} else {
		window.hide()
	}
}

// The page's beforeunload asks to stay only while lib/unloadGuard.ts holds something (transfers, unsaved changes).
function confirmUnload(window: BrowserWindow, action: string): boolean {
	if (!window.isVisible()) {
		window.show()
	}

	const choice = dialog.showMessageBoxSync(window, {
		type: "warning",
		buttons: [action, "Cancel"],
		defaultId: 1,
		cancelId: 1,
		message: "Filen is still working",
		detail: "Transfers are running or changes are not saved yet. They stop if you continue."
	})

	return choice === 0
}

let badgeCount = 0
let badgeDot: NativeImage | null = null

function applyBadge(): void {
	if (PLATFORM !== "win32") {
		// Linux shows it only in launchers that support the Unity count.
		app.setBadgeCount(badgeCount)

		return
	}

	if (badgeCount > 0) {
		badgeDot ??= nativeImage.createFromBitmap(badgeDotBitmap(), { width: BADGE_DOT_SIZE, height: BADGE_DOT_SIZE })
	}

	mainWindow?.setOverlayIcon(badgeCount > 0 ? badgeDot : null, badgeCount > 0 ? `${badgeCount} unread` : "")
}

function createWindow(): void {
	const window = new BrowserWindow(
		windowOptions(
			PLATFORM,
			initialColors(nativeTheme.shouldUseDarkColors),
			path.join(import.meta.dirname, "preload.cjs"),
			!app.isPackaged,
			app.getVersion()
		)
	)

	trackWindowState(window)

	// Kept: the contents are gone by the time "destroyed" fires.
	const contentsId = window.webContents.id

	window.webContents.on("did-finish-load", () => {
		if (pendingOpenPair !== null) {
			window.webContents.send(CHANNELS.syncOpenPair, pendingOpenPair)
			pendingOpenPair = null
		}
	})

	// A new document or none: the old page's sync subscription and plans go.
	window.webContents.on("did-navigate", () => {
		syncService.pageGone(contentsId)
	})
	window.webContents.on("destroyed", () => {
		syncService.pageGone(contentsId)
	})

	window.webContents.on("dom-ready", () => {
		const version = updater?.ready() ?? null

		if (version !== null) {
			window.webContents.send(CHANNELS.updateReady, version)
		}
	})

	window.webContents.setWindowOpenHandler(({ url }) => {
		openExternally(url)

		return { action: "deny" }
	})

	window.webContents.on("will-navigate", (event, url) => {
		if (classifyNavigation(url, APP_ORIGIN) !== "inApp") {
			event.preventDefault()
			openExternally(url)
		}
	})

	window.webContents.on("did-navigate", resetPageState)

	// A reload after a crash that crashes again before its page came up leaves the window to be recreated.
	let recovering = false

	window.webContents.on("dom-ready", () => {
		recovering = false
	})

	// The page and its unsaved state are gone either way. A visible window loads the app again; a hidden one, or one
	// whose reload crashed too, is destroyed, and the next show creates a fresh one.
	window.webContents.on("render-process-gone", (_event, details) => {
		resetPageState()

		if (details.reason === "clean-exit") {
			return
		}

		warn(`renderer gone: ${details.reason}`)

		if (window.isVisible() && !recovering) {
			recovering = true
			window.webContents.reload()
		} else {
			window.destroy()
		}
	})

	window.webContents.on("will-prevent-unload", event => {
		if (installingUpdate || confirmUnload(window, quitting ? "Quit" : "Leave")) {
			event.preventDefault()
		} else {
			quitting = false
		}
	})

	window.once("ready-to-show", () => {
		window.show()
		applyBadge()
	})

	window.on("close", event => {
		const action = closeAction(PLATFORM, quitting, currentPrefs().minimizeToTray)

		if (action === "close") {
			return
		}

		event.preventDefault()

		if (action === "hide") {
			hideWindow(window)
		} else {
			// Through app.quit, so the page's unload guard gets its confirm and a cancel keeps everything running; after
			// this close event, which the quit would otherwise re-enter.
			setImmediate(() => {
				app.quit()
			})
		}
	})

	window.on("hide", () => {
		scheduleIdleDestroy()
		windowHidden()
	})
	window.on("show", () => {
		scheduleIdleDestroy()
		windowShown()
	})
	window.on("minimize", windowHidden)
	window.on("restore", windowShown)

	window.on("closed", () => {
		if (mainWindow === window) {
			mainWindow = null
			resetPageState()
		}
	})

	mainWindow = window
	void window.loadURL(`${APP_ORIGIN}/`)
}

// A menu click reaches the page once it listens; with no window one is created and the action waits for it.
function runMenuAction(action: DesktopMenuAction): void {
	// The lock screen takes no web actions; the click only brings the window up.
	if (isLocked()) {
		showWindow()

		return
	}

	if (mainWindow !== null && menuReady) {
		mainWindow.webContents.send(CHANNELS.menuAction, action)
	} else if (!pendingMenuActions.includes(action)) {
		pendingMenuActions.push(action)
	}

	showWindow()
}

let menuShortcuts: MenuShortcuts = {}

// Windows and Linux have no menu bar (and no default menu's accelerators); macOS gets the full one (D18).
function applyMenu(): void {
	Menu.setApplicationMenu(
		PLATFORM === "darwin"
			? Menu.buildFromTemplate(
					menuTemplate({
						shortcuts: menuShortcuts,
						devTools: !app.isPackaged,
						onAction: runMenuAction,
						onLock: canLock() ? lockNow : null,
						onWebsite: () => {
							void shell.openExternal("https://filen.io")
						}
					})
				)
			: null
	)
}

// Kept for the app's lifetime: the tray is how a window-less app (start minimized, minimize to tray, idle destroy)
// comes back on Windows and Linux.
let tray: Tray | null = null
const trayDirectory = app.isPackaged ? path.join(process.resourcesPath, "tray") : path.join(app.getAppPath(), "build", "tray")

// What the tray shows of sync: the host's last aggregate while it runs.
let syncAggregate: NativeAggregate = "idle"
let syncTray: TrayState = "idle"
let syncStatus: string | null = null
let syncAttentionPair: string | null = null
// Held so it is not collected before it is clicked.
let syncNotification: Notification | null = null
// A pair to open once the page has loaded.
let pendingOpenPair: string | null = null

function trayImage(state: TrayState): NativeImage {
	return nativeImage.createFromPath(path.join(trayDirectory, trayIconFile(PLATFORM, state)))
}

function openSyncPair(pairId: string): void {
	const contents = mainWindow?.webContents

	if (contents !== undefined && !contents.isLoading()) {
		contents.send(CHANNELS.syncOpenPair, pairId)
	} else {
		pendingOpenPair = pairId
	}
}

// Only while the user is elsewhere and wants notifications; the click opens the pair that asked last.
function notifySyncAttention(host: DesktopSyncHostState): void {
	if (!currentPrefs().notifications || BrowserWindow.getFocusedWindow() !== null || !Notification.isSupported()) {
		return
	}

	const pairId = host.state === "failed" ? null : syncAttentionPair

	syncNotification = new Notification({
		title: "Filen",
		body: host.state === "failed" ? "Sync stopped. Open Filen to see why." : "A sync pair needs your attention."
	})
	syncNotification.on("click", () => {
		syncNotification = null
		showWindow()

		if (pairId !== null) {
			openSyncPair(pairId)
		}
	})
	syncNotification.show()
}

function applySyncTray(): void {
	const host = nativeSupervisor.state()
	const next = trayState(syncAggregate, host)
	const status = traySyncStatus(next, host)
	const previous = syncTray

	syncTray = next

	// Activity names the pair before the aggregate turns; it is forgotten once the attention is over.
	if (previous === "attention" && next !== "attention") {
		syncAttentionPair = null
	}

	if (tray !== null && next !== previous) {
		tray.setImage(trayImage(next))
	}

	if (status !== syncStatus) {
		syncStatus = status
		tray?.setToolTip(trayTooltip(next, host))
		applyTrayMenu()
	}

	if (attentionTransitions(previous, next)) {
		notifySyncAttention(host)
	}
}

function canLock(): boolean {
	const status = appLock?.status()

	return status !== undefined && status.enabled && !status.locked
}

function applyTrayMenu(): void {
	tray?.setContextMenu(
		Menu.buildFromTemplate([
			...(syncStatus === null ? [] : [{ label: syncStatus, enabled: false }, { type: "separator" as const }]),
			{ label: "Open Filen", click: showWindow },
			...(canLock() ? [{ label: "Lock Filen", click: lockNow }] : []),
			{ type: "separator" },
			{ label: "Quit Filen", click: () => app.quit() }
		])
	)
}

function createTray(): void {
	tray = new Tray(trayImage(syncTray))
	tray.setToolTip(trayTooltip(syncTray, nativeSupervisor.state()))
	applyTrayMenu()
	tray.on("click", showWindow)
}

async function applyLaunchAtLogin(enabled: boolean): Promise<void> {
	// Registering the development Electron binary would start it at every login.
	if (!app.isPackaged) {
		warn("launch at login is only applied to a packaged app")

		return
	}

	if (PLATFORM === "linux") {
		await setAutostart(
			autostartFile(process.env["XDG_CONFIG_HOME"], app.getPath("home")),
			// An AppImage runs from a temporary mount; the image itself is what must start.
			enabled ? [process.env["APPIMAGE"] ?? process.execPath, HIDDEN_ARG] : null
		)

		return
	}

	// macOS reports a login launch through wasOpenedAtLogin; Windows passes the argument.
	app.setLoginItemSettings(PLATFORM === "win32" ? { openAtLogin: enabled, args: [HIDDEN_ARG] } : { openAtLogin: enabled })
}

// One redacted text file: the shell's log and the page's. The destination comes from the save dialog only.
async function exportLogs(webLog: string): Promise<DesktopLogsExport> {
	const stamp = new Date()
		.toISOString()
		.replaceAll(":", "-")
		.replace(/\.\d+Z$/, "Z")
	const options = {
		title: "Export logs",
		defaultPath: path.join(app.getPath("downloads"), `filen-desktop-logs-${stamp}.txt`),
		filters: [{ name: "Text", extensions: ["txt"] }]
	}
	const choice = await (mainWindow === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(mainWindow, options))

	if (choice.canceled || choice.filePath === undefined || choice.filePath.length === 0) {
		return "canceled"
	}

	const header = `Filen ${app.getVersion()} (Electron ${process.versions.electron}, ${PLATFORM} ${process.arch} ${os.release()})\nExported ${new Date().toISOString()}\n`

	await writeFile(choice.filePath, `${header}\n== Shell ==\n${redact(await fileLog.read())}\n== Web ==\n${redact(webLog)}\n`, {
		mode: 0o600
	})
	info("logs exported")

	return "saved"
}

function isTrusted(senderFrame: WebFrameMain | null): boolean {
	return isTrustedSender(senderFrame?.url, APP_ORIGIN)
}

if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on("second-instance", showWindow)
	app.on("before-quit", () => {
		quitting = true
	})
	// After the windows closed (and the page's unload guard agreed): the native host closes its engine first.
	app.on("will-quit", event => {
		if (nativeSupervisor.active()) {
			event.preventDefault()
			void nativeSupervisor.stop().finally(() => {
				app.quit()
			})
		}
	})
	app.on("browser-window-focus", () => {
		nativeSupervisor.ensure("focus")
	})
	app.on("activate", showWindow)
	// Every web contents, including any created later: no <webview>, no new windows and no navigation off the app
	// origin. A window's own handlers come on top (its window-open handler replaces this default); the legacy-origin
	// window loads its page through loadURL, which no navigation guard sees.
	app.on("web-contents-created", (_event, contents) => {
		contents.on("will-attach-webview", event => {
			event.preventDefault()
		})
		contents.setWindowOpenHandler(() => ({ action: "deny" }))
		contents.on("will-navigate", (event, url) => {
			if (classifyNavigation(url, APP_ORIGIN) !== "inApp") {
				event.preventDefault()
			}
		})
	})
	// The app outlives its window everywhere: macOS in the dock, Windows and Linux in the tray (minimize to tray, idle
	// destroy). Quitting is always explicit.
	app.on("window-all-closed", () => undefined)

	ipcMain.on(CHANNELS.setTitleBarColors, (event, payload: unknown) => {
		if (!isTrusted(event.senderFrame) || PLATFORM === "darwin") {
			return
		}

		const colors = titleBarColorsSchema(payload)

		if (colors instanceof type.errors) {
			return
		}

		const window = BrowserWindow.fromWebContents(event.sender)

		window?.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor })

		// Windows 11 draws the border in this colour (a no-op on Windows 10, which gets the page's border).
		if (PLATFORM === "win32") {
			window?.setAccentColor(colors.border)
		}
	})

	// Every invoke handler answers the app's own top-level document only.
	function handle(channel: string, listener: (...args: unknown[]) => Promise<unknown>): void {
		ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
			if (!isTrustedSender(event.senderFrame?.url, APP_ORIGIN)) {
				throw new Error("untrusted sender")
			}

			return listener(...args)
		})
	}

	handle(CHANNELS.sessionGet, () => sessionVault.get())
	handle(CHANNELS.sessionSet, async blob => {
		if (!isSessionBlob(blob)) {
			throw new Error("invalid session")
		}

		await sessionVault.set(blob)
		nativeSupervisor.sessionChanged(blob)
		void migration.sessionConfirmed(blob)
	})
	handle(CHANNELS.sessionClear, async () => {
		try {
			await sessionVault.clear()
		} finally {
			syncSignedOut()
		}
	})
	ipcMain.on(CHANNELS.sessionVerified, event => {
		if (!isTrusted(event.senderFrame)) {
			return
		}

		nativeSupervisor.ensure("session verified")

		// The vault logs its own failures; nothing is confirmed without a readable session.
		void sessionVault
			.get()
			.then(read => migration.sessionConfirmed(read.status === "present" ? read.blob : null))
			.catch(() => undefined)
	})

	handle(CHANNELS.prefsGet, async () => (await prefsLoading).get())
	handle(CHANNELS.prefsSet, async payload => {
		const patch = prefsPatchSchema(payload)

		if (patch instanceof type.errors) {
			throw new Error("invalid prefs")
		}

		const store = await prefsLoading

		if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== store.get().launchAtLogin) {
			await applyLaunchAtLogin(patch.launchAtLogin)
		}

		const next = await store.set(patch)

		scheduleIdleDestroy()

		return next
	})

	ipcMain.on(CHANNELS.showWindow, event => {
		if (isTrusted(event.senderFrame)) {
			showWindow()
		}
	})

	ipcMain.on(CHANNELS.setBadge, (event, payload: unknown) => {
		const count = countSchema(payload)

		if (!isTrusted(event.senderFrame) || count instanceof type.errors || count === badgeCount) {
			return
		}

		badgeCount = count
		applyBadge()
	})

	ipcMain.on(CHANNELS.setUnloadHolds, (event, payload: unknown) => {
		const count = countSchema(payload)

		if (!isTrusted(event.senderFrame) || count instanceof type.errors) {
			return
		}

		unloadHolds = count
		scheduleIdleDestroy()
	})

	ipcMain.on(CHANNELS.setAudioPlaying, (event, payload: unknown) => {
		const playing = audioPlayingSchema(payload)

		if (!isTrusted(event.senderFrame) || playing instanceof type.errors) {
			return
		}

		audioPlaying = playing
		scheduleIdleDestroy()
	})

	ipcMain.on(CHANNELS.setMenuShortcuts, (event, payload: unknown) => {
		const combos = menuShortcutsSchema(payload)

		if (!isTrusted(event.senderFrame) || combos instanceof type.errors || PLATFORM !== "darwin") {
			return
		}

		const next = Object.fromEntries(Object.entries(combos).filter(([id]) => isMenuAction(id))) as MenuShortcuts

		if (JSON.stringify(next) !== JSON.stringify(menuShortcuts)) {
			menuShortcuts = next
			applyMenu()
		}
	})

	ipcMain.on(CHANNELS.menuReady, event => {
		if (!isTrusted(event.senderFrame) || mainWindow?.webContents !== event.sender) {
			return
		}

		menuReady = true

		for (const action of pendingMenuActions) {
			event.sender.send(CHANNELS.menuAction, action)
		}

		pendingMenuActions = []
	})

	ipcMain.on(CHANNELS.installUpdate, event => {
		const window = BrowserWindow.fromWebContents(event.sender)

		if (!isTrusted(event.senderFrame) || updater === null || updater.ready() === null || installingUpdate || window === null) {
			return
		}

		// Asked here, before the installer starts (Windows and Linux launch it before quitting, so the page's own
		// unload confirm would come too late). A cancel installs nothing; the update still installs on the next quit.
		if (unloadHolds > 0 && !confirmUnload(window, "Restart")) {
			return
		}

		installUpdateNow()
	})

	handle(CHANNELS.lockStatus, async () => {
		const lock = await appLockLoading

		await lock.reload()

		return lock.status()
	})
	handle(CHANNELS.lockUnlock, async pin => {
		const valid = desktopPinSchema(pin)

		if (valid instanceof type.errors) {
			throw new Error("invalid pin")
		}

		const lock = await appLockLoading
		const result = await lock.unlock(valid)

		if (result.ok) {
			info("app lock: unlocked")
		}

		lockChanged()

		return result
	})
	handle(CHANNELS.lockSet, async (...args) => {
		const valid = pinChangeSchema(args)

		if (valid instanceof type.errors) {
			throw new Error("invalid pin")
		}

		const result = await (await appLockLoading).set(valid[0], valid[1])

		lockChanged()

		return result
	})
	handle(CHANNELS.lockClear, async pin => {
		const valid = desktopPinSchema(pin)

		if (valid instanceof type.errors) {
			throw new Error("invalid pin")
		}

		const result = await (await appLockLoading).clear(valid)

		lockChanged()

		return result
	})
	// A forgotten PIN signs out: the session it guarded goes first, so a failure leaves the app locked.
	handle(CHANNELS.lockReset, async () => {
		const lock = await appLockLoading

		await sessionVault.clear()
		syncSignedOut()
		await lock.reset()
		info("app lock: reset by signing out")
		lockChanged()
	})
	ipcMain.on(CHANNELS.lockNow, event => {
		if (isTrusted(event.senderFrame)) {
			lockNow()
		}
	})

	registerSyncIpc(ipcMain, syncService, url => isTrustedSender(url, APP_ORIGIN))

	handle(CHANNELS.logsExport, async payload => {
		const webLog = webLogSchema(payload)

		if (webLog instanceof type.errors) {
			throw new Error("invalid log")
		}

		return exportLogs(webLog)
	})

	// First and on its own, so neither startup nor a renderer can hold it back.
	app.whenReady()
		.then(() => {
			if (app.isPackaged) {
				const testFeed = testUpdateFeed(process.env["FILEN_DESKTOP_TEST_UPDATE_FEED"])

				updater = startUpdater(
					{ info, warn },
					version => {
						info(`updater: ${version} is ready to install`)

						if (testFeed !== null) {
							installUpdateNow()
						} else {
							mainWindow?.webContents.send(CHANNELS.updateReady, version)
						}
					},
					testFeed
				)
			}
		})
		.catch((error: unknown) => {
			warn(`updater did not start: ${error instanceof Error ? error.message : String(error)}`)
		})

	app.whenReady()
		.then(async () => {
			prefs = await prefsLoading
			appLock = await appLockLoading
			applyMenu()
			createTray()

			const { defaultSession } = session

			defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
				callback(isPermissionAllowed(permission, details.requestingUrl, APP_ORIGIN))
			})
			defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
				isPermissionAllowed(permission, requestingOrigin, APP_ORIGIN)
			)

			// A sleep stops the hidden-window timer; the screen lock is a moment to lock too.
			powerMonitor.on("resume", lockIfHiddenTooLong)
			powerMonitor.on("unlock-screen", lockIfHiddenTooLong)
			powerMonitor.on("lock-screen", lockNow)

			// Without its headers the web app cannot run (no cross-origin isolation, no CSP), so a missing file is fatal.
			registerAppProtocol(SCHEME, webDist, parseHeaders(readFileSync(path.join(webDist, "_headers"), "utf8")))

			// Before the first window, so the page boots with the imported session, PIN and prefs.
			if ((await migration.start()).pinImported) {
				lockNow()
			}

			started = true
			nativeSupervisor.ensure("launch")

			const openedAtLogin = PLATFORM === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin

			if (showRequested || !startsHidden(process.argv, prefs.get().startMinimized, openedAtLogin)) {
				showWindow()
			}
		})
		.catch((error: unknown) => {
			dialog.showErrorBox("Filen", `Filen could not start.\n\n${error instanceof Error ? error.message : String(error)}`)
			app.exit(1)
		})
}
