import {
	app,
	autoUpdater as squirrel,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	type IpcMainInvokeEvent,
	Menu,
	type NativeImage,
	nativeImage,
	type OpenDialogOptions,
	type OpenDialogReturnValue,
	nativeTheme,
	type SaveDialogOptions,
	Notification,
	powerMonitor,
	protocol,
	safeStorage,
	session,
	shell,
	Tray,
	utilityProcess,
	webContents,
	type WebContents,
	type WebFrameMain
} from "electron"
import { existsSync, readFileSync } from "node:fs"
import { lstat, mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises"
import { lookup } from "node:dns/promises"
import { createRequire } from "node:module"
import os from "node:os"
import { type } from "arktype"
import path from "node:path"
import type {
	DesktopLogsExport,
	DesktopMediaTransport,
	DesktopMenuAction,
	DesktopMountsRole,
	DesktopPlatform,
	DesktopSyncHostState,
	WindowState
} from "@filen/shared/desktop"
import { desktopPinSchema } from "@filen/shared/desktopLock"
import { CHANNELS } from "../shared/channels.ts"
import type { NativeAggregate } from "../shared/nativeProtocol.ts"
import { type AppLock, inactivityLock, loadAppLock } from "./appLock.ts"
import { atomicFile, codedError, errorCode } from "./atomicFile.ts"
import { autostartFile, setAutostart } from "./autostart.ts"
import { BADGE_DOT_SIZE, badgeDotBitmap } from "./badge.ts"
import { parseHeaders } from "./headers.ts"
import { createFileLog } from "./fileLog.ts"
import { createDragOutAddon, type DragOutAddonMac } from "./dragOut/addon.ts"
import { createDragOutAddonWin } from "./dragOut/addonWin.ts"
import { registerDragOutIpc } from "./dragOut/ipc.ts"
import { createQuitAfterDrag } from "./dragOut/quit.ts"
import { createDragOutService, type DragOutNative } from "./dragOut/service.ts"
import { DragSessions } from "./dragOut/session.ts"
import { createDragTemp } from "./dragOut/temp.ts"
import { createFileProviderAddon, type FileProviderAddonContext, fileProviderAddonPath } from "./fileProvider/addon.ts"
import { registerFileProviderIpc } from "./fileProvider/ipc.ts"
import { createFileProviderService, runsTranslocated } from "./fileProvider/service.ts"
import { createFileProviderStore } from "./fileProvider/store.ts"
import {
	acquireInstanceLock,
	appIdentity,
	closeAction,
	HIDDEN_ARG,
	IDLE_DESTROY_DELAY_MS,
	keepsRendererAlive,
	startsHidden,
	UPDATER_RELAUNCH_ENV
} from "./lifecycle.ts"
import { READ_SCRIPT, WIPE_SCRIPT } from "./legacyData.ts"
import { deleteLegacyStores, LEGACY_SCHEME, legacyProfileExists, runInLegacyOrigin } from "./legacyOrigin.ts"
import { isDevToolsKey, isMenuAction, type MenuShortcuts, menuTemplate, TRANSPORT_ACTIONS, transportItems, zoomLevelAfter } from "./menu.ts"
import { applyShellStrings, loadShellStrings, shellPlural, shellText } from "./shellStrings.ts"
import {
	createMigration,
	createStashStore,
	legacyLogsDir,
	legacyOwner,
	parseMarker,
	type PurgeOutcome,
	purgeBeforeReady
} from "./migration.ts"
import { addonPath, macAddonPath } from "./native/addonPath.ts"
import { createCredentialStore, type CredentialStore } from "./mounts/credentials.ts"
import { type FuseContext, fuseStatus, installWinFsp, linuxFuseGap, runProgram } from "./mounts/fuse.ts"
import { registerMountsIpc } from "./mounts/ipc.ts"
import { createHostResolver } from "./mounts/addresses.ts"
import { createLegacyMounts } from "./mounts/legacyApply.ts"
import { endLegacyDriveRclone } from "./mounts/legacyRclone.ts"
import { configuredMountPoints } from "./mounts/mountPoint.ts"
import { bakedRcloneSha256, rclonePaths } from "./mounts/rclonePath.ts"
import { createMountsService } from "./mounts/service.ts"
import { loadMountsStore, type MountsStore } from "./mounts/store.ts"
import { ensureCertificate } from "./mounts/tls.ts"
import { anyDemand, createNativeSupervisor } from "./native/supervisor.ts"
import { classifyNavigation, isTrustedSender } from "./navigation.ts"
import { isPermissionAllowed } from "./permissions.ts"
import { DEFAULT_PREFS, loadPrefs, prefsPatchSchema, type PrefsStore } from "./prefs.ts"
import { type HostProxy, PROXY_RESOLVE_WAIT_MS, resolveHostProxy } from "./proxy.ts"
import { registerAppProtocol, registerDevProxy } from "./serve.ts"
import { createSessionEnd, shouldConfirmQuit, unloadGuardAsks } from "./quitConfirm.ts"
import { redact } from "./redact.ts"
import { registerSessionRecoveryIpc, sessionDiscarder, type VaultDependent } from "./sessionRecovery.ts"
import { registerBrowserCacheIpc, sessionBrowserCache } from "./browserCache.ts"
import { createSignOut, deleteProfileStorage, type ProfileOutcome, removeTree, wipeProfileBeforeReady } from "./signOut.ts"
import { parseSessionBlob } from "@filen/shared/session"
import {
	createSessionVault,
	isSessionBlob,
	lazyCipher,
	removeIfUndecryptable,
	sessionUserId,
	vaultMode,
	type VaultCipher
} from "./sessionVault.ts"
import { registerSyncIpc } from "./sync/ipc.ts"
import { createRootTokens } from "./sync/localRoot.ts"
import { createSyncService } from "./sync/service.ts"
import { readLegacyIgnorer, retireLegacySyncState } from "./sync/legacyState.ts"
import { heldRemotes, loadSyncStore, type SyncStore } from "./sync/store.ts"
import {
	attentionPair,
	attentionTransitions,
	roleFailureMessage,
	trayIconFile,
	trayState,
	type TrayState,
	trayStatusLines,
	trayTooltip
} from "./tray.ts"
import { registerTransfersIpc } from "./transfers/ipc.ts"
import { createStagingJournal } from "./transfers/journal.ts"
import { createTransfersService } from "./transfers/service.ts"
import { startUpdater, testUpdateFeed, type Updater, type UpdaterEngine } from "./updater.ts"
import { drawsOwnBorder, initialColors, titleBarColorsSchema, windowOptions } from "./window.ts"

// Payloads from the renderer are untrusted input.
const countSchema = type("0 <= number.integer < 1000000")
const audioPlayingSchema = type("boolean")
const mediaTransportSchema = type("'none' | 'paused' | 'playing'")
const zoomStepSchema = type("'in' | 'out' | 'reset'")
const menuShortcutsSchema = type({ "[string]": "string <= 64" })
const pinChangeSchema = type([desktopPinSchema, desktopPinSchema.or("null")])
// The page's own log ring holds a few hundred lines; this only stops an unbounded payload.
const webLogSchema = type("string <= 16777216")

const SCHEME = "filen"
const APP_ORIGIN = `${SCHEME}://app`
const PLATFORM = process.platform as DesktopPlatform

// Set before ready, when safeStorage reads the name.
const identity = appIdentity(app.isPackaged)

app.setPath("userData", path.join(app.getPath("appData"), identity.userData))
app.setName(identity.name)
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
// `pnpm run dev` (scripts/dev.ts) serves the page from filen-web's Vite server instead, for hot reload.
const webDevServer = app.isPackaged ? undefined : process.env["FILEN_DESKTOP_WEB_DEV_URL"]

// Probed on first use, after app ready: safeStorage reports nothing useful before it. On Linux a missing or locked
// Secret Service (or a dismissed prompt) still reports the keyring's backend while encrypting with Chromium's hardcoded
// fallback key, which only a probe's "v10" shows; it is logged once and stored with all the same (a run with the
// keyring's key, "v11", re-encrypts what it reads).
async function sessionCipher(): Promise<VaultCipher | null> {
	const linux = PLATFORM === "linux"
	const backend = linux ? safeStorage.getSelectedStorageBackend() : ""
	const available = await safeStorage.isAsyncEncryptionAvailable()
	const probe = linux && available ? await safeStorage.encryptStringAsync("probe") : null
	// The ciphertext's version prefix only.
	const prefix = probe?.subarray(0, 3).toString("latin1") ?? "none"

	info(
		`secure storage: ${available ? "available" : "unavailable"}${linux ? `, backend ${backend || "none"}, probe ${/^(v\d\d|none)$/.test(prefix) ? prefix : "unrecognised"}` : ""}`
	)

	if (vaultMode(PLATFORM, backend, available) === "memory") {
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
const sessionVaultPath = path.join(app.getPath("userData"), "session.vault")
const sessionVault = createSessionVault(vaultCipher, atomicFile(sessionVaultPath), warn)

// Read before ready; the window and every pref-dependent decision come after ready, once this has settled.
const prefsLoading = loadPrefs(atomicFile(path.join(app.getPath("userData"), "prefs.json")), warn)
// The shell's text in the UI language the page last reported (menu, tray, notifications, dialogs).
const shellStringsFile = atomicFile(path.join(app.getPath("userData"), "shellStrings.json"))
const shellStringsLoading = loadShellStrings(shellStringsFile, warn)
let prefs: PrefsStore | null = null

const userDataPath = app.getPath("userData")
// Sync: one engine directory per user, never under the old client's userData/sync.
const syncEngineRoot = path.join(userDataPath, "sync-engine")
// Mounts: config, credentials and certificates per user, beside the user's rclone cache.
const mountsRoot = path.join(userDataPath, "mounts")
const lockFilePath = path.join(userDataPath, "lock.vault")
const signOutMarkerPath = path.join(userDataPath, "signOut.pending")

// What a sign-out deletes (signOut.ts). Its steps run only once startup has finished.
const signOutFlow = createSignOut({
	steps: {
		fileProvider: userId => fileProvider.signedOut(userId),
		mounts: userId => mountsService.signOut(userId),
		stopHost: async () => {
			// Before the host stops: its rows end cancelled, never interrupted. Their staging files go once it has
			// stopped writing them.
			const discardStaging = transfersService.signedOut()
			const discardDragTemp = dragOut.signedOut()
			const stopped = nativeSupervisor.signedOut()

			syncService.signedOut()
			mountsService.signedOut()
			await stopped
			await discardStaging()
			await discardDragTemp()
		},
		forget: (userId, parts) => {
			if (parts.includes("sync")) {
				syncStores.delete(userId)
			}

			if (parts.includes("mounts")) {
				mountsStores.delete(userId)
				credentialStores.delete(userId)
			}
		},
		discardStash: async () => {
			await migration.signedOut()
			await migrationStash.discard()
		},
		resetLock: async () => {
			await (await appLockLoading).reset()
			lockChanged()
		},
		clearLogs: () => fileLog.clear(removeTree)
	},
	syncRoot: syncEngineRoot,
	mountsRoot,
	lockFile: lockFilePath,
	marker: atomicFile(signOutMarkerPath),
	remove: removeTree,
	profile: () => profileWipe,
	log: { info, warn }
})
// Set before ready, once this instance holds the single-instance lock; see wipeProfileBeforeReady.
let profileWipe: ProfileOutcome = { result: "not-due" }

// What a sign-out left is deleted once this instance holds the single-instance lock, before ready.
const signOutResumed = Promise.withResolvers<void>()
// Read from before ready like the prefs (decrypting waits for ready), once what a sign-out left is gone; no window is
// created before it has settled, and neither the sync nor the mounts stores are read before.
const appLockLoading = signOutResumed.promise.then(() => loadAppLock(atomicFile(lockFilePath), vaultCipher, warn))
let appLock: AppLock | null = null

// What the migration kept for the later phases (sync pairs, mounts), encrypted like the vault.
const migrationStashFile = atomicFile(path.join(userDataPath, "migration.stash"))
const migrationStash = createStashStore(migrationStashFile, vaultCipher, warn)

const migrationMarkerPath = path.join(userDataPath, "migration.json")
const migrationMarker = atomicFile(migrationMarkerPath)
// Set before ready, once this instance holds the single-instance lock; see purgeBeforeReady.
let earlyPurge: PurgeOutcome = { result: "not-due" }

// The one-time import from the old client. Runs after ready and before the first window; see migration.ts.
const migration = createMigration({
	marker: migrationMarker,
	legacyProfile: () => legacyProfileExists(userDataPath),
	readLegacy: () => runInLegacyOrigin(READ_SCRIPT),
	readOptions: async () => (await atomicFile(path.join(userDataPath, "options.v1.json")).read())?.toString("utf8") ?? null,
	wipeLegacy: async () => {
		if ((await runInLegacyOrigin(WIPE_SCRIPT)) !== true) {
			throw codedError("indexeddb not deleted")
		}
	},
	// The old client's generated rclone remote: the account's keys, merely obscured.
	removeRcloneConfig: () => rm(path.join(userDataPath, "rclone", "rclone.conf"), { force: true }),
	// Development has its own userData beside a real installation's, so only a packaged app deletes the old logs.
	removeLegacyLogs: () => (app.isPackaged ? removeTree(legacyLogsDir(userDataPath)) : Promise.resolve()),
	earlyPurge: () => earlyPurge,
	vault: sessionVault,
	lock: {
		enabled: () => appLock?.status().enabled ?? true,
		set: async pin => (await (await appLockLoading).set(pin, null)).ok
	},
	prefs: { set: async patch => (await prefsLoading).set(patch) },
	launchesAtLogin: () =>
		PLATFORM !== "linux" && app.getLoginItemSettings(PLATFORM === "win32" ? { args: [HIDDEN_ARG] } : undefined).openAtLogin,
	applyLaunchAtLogin: enabled => applyLaunchAtLogin(enabled),
	writeStash: text => migrationStash.write(text),
	now: Date.now,
	info,
	warn
})

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

const mountsStores = new Map<string, Promise<MountsStore>>()
const credentialStores = new Map<string, CredentialStore>()

async function mountsDir(userId: string): Promise<string> {
	const dir = path.join(mountsRoot, userId)

	await mkdir(dir, { recursive: true, mode: 0o700 })

	return dir
}

// Read once per user; the directory is created by the first write.
function mountsStoreFor(userId: string): Promise<MountsStore> {
	let store = mountsStores.get(userId)

	if (store === undefined) {
		const file = atomicFile(path.join(mountsRoot, userId, "mounts.json"))

		store = loadMountsStore(
			{
				...file,
				write: async data => {
					await mountsDir(userId)
					await file.write(data)
				}
			},
			warn
		)
		mountsStores.set(userId, store)
	}

	return store
}

function credentialStoreFor(userId: string): CredentialStore {
	let store = credentialStores.get(userId)

	if (store === undefined) {
		const file = atomicFile(path.join(mountsRoot, userId, "credentials.bin"))

		store = createCredentialStore(
			{
				...file,
				write: async data => {
					await mountsDir(userId)
					await file.write(data)
				}
			},
			vaultCipher,
			warn
		)
		credentialStores.set(userId, store)
	}

	return store
}

// Every other file the vault's cipher encrypted, for when the session's key is gone.
async function vaultDependents(): Promise<VaultDependent[]> {
	const users = await readdir(mountsRoot, { withFileTypes: true }).catch((error: unknown) => {
		if (errorCode(error) !== "ENOENT") {
			warn(`session recovery: mounts not listed: ${errorCode(error)}`)
		}

		return []
	})

	return [
		{
			label: "app lock",
			discard: async cipher => {
				const removed = await (await appLockLoading).discardUndecryptable(cipher)

				if (removed) {
					lockChanged()
				}

				return removed
			}
		},
		{ label: "migration stash", discard: cipher => removeIfUndecryptable(migrationStashFile, cipher) },
		...users
			.filter(entry => entry.isDirectory())
			.map(entry => ({
				label: "mount credentials",
				discard: (cipher: VaultCipher | null) =>
					removeIfUndecryptable(atomicFile(path.join(mountsRoot, entry.name, "credentials.bin")), cipher)
			}))
	]
}

const discardUnreadableSession = sessionDiscarder({ vault: sessionVault, cipher: vaultCipher, dependents: vaultDependents, info, warn })

// The bundled rclone (on Linux with the digest the build baked in) and the FUSE installer shipped beside it.
const rclone = rclonePaths({
	packaged: app.isPackaged,
	resourcesPath: process.resourcesPath,
	env: process.env,
	appPath: app.getAppPath(),
	platform: process.platform,
	arch: process.arch,
	sha256: bakedRcloneSha256,
	exists: existsSync
})
const fuseContext: FuseContext = {
	platform: process.platform,
	arch: process.arch,
	env: process.env,
	exists: existsSync,
	run: runProgram,
	fuseInstaller: rclone?.fuseInstaller ?? null
}
const { fuseInstaller } = fuseContext

// Resolved once the app is ready; the host's first start waits for it, and the rclone it starts inherits its
// environment.
let hostProxy: HostProxy | null = null

const nativeSupervisor = createNativeSupervisor({
	fork: () =>
		utilityProcess.fork(path.join(import.meta.dirname, "native.js"), [], {
			serviceName: "Filen Helper",
			stdio: "pipe",
			env: hostProxy?.env() ?? process.env
		}),
	forkReady: () => hostProxy?.ready ?? Promise.resolve(),
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
	macAddonPath: () =>
		macAddonPath({
			packaged: app.isPackaged,
			resourcesPath: process.resourcesPath,
			appPath: app.getAppPath(),
			platform: process.platform,
			arch: process.arch,
			exists: existsSync
		}),
	dirFor: engineDir,
	holdRemotes: async userId => heldRemotes((await syncStoreFor(userId)).get()),
	demand: userId =>
		anyDemand([
			() => transfersService.active(userId) > 0,
			() => dragOut.live() > 0,
			async () => (await syncStoreFor(userId)).hasPairs(),
			async () => (await migrationStash.pending(userId, "sync")) !== undefined,
			async () => (await mountsStoreFor(userId)).anyEnabled(),
			() => legacyMounts.wanted(userId)
		]),
	log: { info, warn },
	onMessage: (message, userId) => {
		if (message.t === "transfers") {
			transfersService.nativeEvent(message, userId)

			return
		}

		if (message.t === "ready" || message.t === "mounts" || message.t === "mountsStats") {
			mountsService.nativeEvent(message, userId)
		}

		if (message.t === "mounts" || message.t === "mountsStats") {
			return
		}

		if (message.t === "aggregate") {
			syncAggregate = message.state
			applyTray()
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
		mountsService.hostChanged(state)
		transfersService.hostChanged(state, nativeSupervisor.generation())
		applyTray()
	},
	onRevoked: userId => {
		info("session revoked by the server; signed out")
		void signOutFlow.signOut(userId)
		mainWindow?.webContents.send(CHANNELS.sessionRevoked)
	}
})

// The directory chooser of a sync pair and of the drive's mount point; logged without the path, so main.log shows
// whether a page's call reached the dialog and how long it took to answer (the OS opening it included).
async function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
	const started = Date.now()

	info(`directory chooser opening (${options.title ?? "untitled"})`)

	try {
		const result = await (mainWindow === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(mainWindow, options))

		info(`directory chooser answered (${result.canceled ? "canceled" : "chosen"}) in ${String(Date.now() - started)} ms`)

		return result
	} catch (error) {
		warn(`directory chooser failed after ${String(Date.now() - started)} ms: ${errorCode(error)}`)

		throw error
	}
}

async function showSaveDialog(options: SaveDialogOptions): Promise<string | null> {
	const result = await (mainWindow === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(mainWindow, options))

	return result.canceled || result.filePath.length === 0 ? null : result.filePath
}

// The staging files of downloads in flight, swept at startup after an unclean exit.
const transfersJournal = createStagingJournal({
	file: atomicFile(path.join(userDataPath, "transfers-staging.json")),
	fs: { lstat, unlink, readdir: dir => readdir(dir, { withFileTypes: true }) },
	schedule: run => {
		setImmediate(run)
	},
	log: { warn }
})

const transfersService = createTransfersService({
	supervisor: nativeSupervisor,
	prefs: {
		get: currentPrefs,
		setDownloadDirectory: async downloadDirectory => (await prefsLoading).setDownloadDirectory(downloadDirectory)
	},
	dialogs: {
		save: showSaveDialog,
		open: async options => {
			const result = await showOpenDialog(options)

			return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
		}
	},
	fs: {
		stat: target => stat(target).catch(() => null),
		exists: target =>
			lstat(target).then(
				() => true,
				(error: unknown) => errorCode(error) !== "ENOENT"
			)
	},
	shell: { showItemInFolder: target => shell.showItemInFolder(target), openPath: target => shell.openPath(target) },
	journal: transfersJournal,
	downloadsDir: () => app.getPath("downloads"),
	platform: process.platform,
	now: Date.now,
	log: { info, warn }
})

// Drag-out: drive items dragged out of the window onto the OS (src/main/dragOut). Temp copies live under userData,
// per app identity.
const dragTemp = createDragTemp({
	root: path.join(userDataPath, "drag-out"),
	uid: process.getuid?.() ?? null,
	now: Date.now,
	setTimer: (run, ms) => {
		const timer = setTimeout(run, ms)

		timer.unref()

		return () => {
			clearTimeout(timer)
		}
	},
	log: { warn }
})

function dragOutNative(): DragOutNative {
	const context = {
		packaged: app.isPackaged,
		resourcesPath: process.resourcesPath,
		appPath: app.getAppPath(),
		platform: process.platform,
		arch: process.arch,
		exists: existsSync,
		load: (file: string): unknown => createRequire(import.meta.url)(file)
	}

	if (PLATFORM === "darwin") {
		// Loaded on the first drag out.
		let addon: DragOutAddonMac | null | undefined

		return { mode: "promise", addon: () => (addon ??= createDragOutAddon({ ...context, warn })) }
	}

	return PLATFORM === "win32" ? { mode: "virtual", addon: createDragOutAddonWin(context) } : { mode: "staged" }
}

const dragNative = dragOutNative()

const dragSessions = new DragSessions(
	{
		transfers: transfersService,
		temp: dragTemp,
		emit: (state, owner) => {
			dragOut.emit(state, owner)
		},
		now: Date.now,
		setTimer: (run, ms) => {
			const timer = setTimeout(run, ms)

			return () => {
				clearTimeout(timer)
			}
		}
	},
	PLATFORM,
	dragNative.mode
)

const dragOut = createDragOutService<NativeImage>({
	sessions: dragSessions,
	temp: dragTemp,
	native: dragNative,
	user: async () => (await nativeSupervisor.user())?.userId ?? null,
	windows: {
		focused: owner => {
			const contents = webContents.fromId(owner)
			const window = contents === undefined ? null : BrowserWindow.fromWebContents(contents)

			if (contents === undefined || window === null || !window.isFocused()) {
				return null
			}

			return {
				handle: () => window.getNativeWindowHandle(),
				startDrag: (files, icon) => {
					contents.startDrag({ file: files[0] ?? "", files, icon })
				}
			}
		}
	},
	decodeIcon: (png, scaleFactor) => nativeImage.createFromBuffer(png, { scaleFactor }),
	log: { warn }
})
// Before-quit waits for a native drag to return (Linux's nested loop and macOS's drag tracking run IPC and the tray).
const quitAfterDrag = createQuitAfterDrag({
	running: () => dragOut.nativeDragRunning(),
	idle: () => dragOut.idle(),
	quit: () => {
		app.quit()
	}
})

// Where neither a sync pair nor the network drive may be.
function reservedDirectories() {
	return {
		platform: process.platform,
		home: app.getPath("home"),
		appData: [userDataPath, app.getPath("appData")],
		temporary: [app.getPath("temp"), os.tmpdir()]
	}
}

const syncService = createSyncService({
	supervisor: nativeSupervisor,
	storeFor: syncStoreFor,
	tokens: createRootTokens(Date.now),
	dialogs: {
		showOpenDialog,
		rootContext: () => ({
			...reservedDirectories(),
			oneDrive:
				PLATFORM === "win32"
					? ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].flatMap(name => {
							const dir = process.env[name]

							return dir === undefined || dir.length === 0 ? [] : [dir]
						})
					: []
		}),
		mountPoints: async userId => configuredMountPoints((await mountsStoreFor(userId)).get(), process.platform)
	},
	shell: { openPath: target => shell.openPath(target) },
	legacySync: {
		pending: userId => migrationStash.pending(userId, "sync"),
		consume: userId => migrationStash.consume(userId, "sync"),
		ignorer: uuid => readLegacyIgnorer(userDataPath, uuid, warn),
		retire: async () => {
			const retired = await retireLegacySyncState(userDataPath, Date.now())

			if (retired !== "absent") {
				info(`sync: the previous app's sync state was kept as ${retired.renamedTo}`)
			}
		}
	},
	driveRoot: async userId => {
		const read = await sessionVault.get()
		const session = read.status === "present" ? parseSessionBlob(read.blob) : null

		return session !== null && String(session.userId) === userId ? session.rootUuid : null
	},
	onHeld: held => {
		syncHeld = held
		applyTray()
	},
	now: Date.now,
	log: { info, warn }
})

// Uploads the drive still holds ask before a sign-out; with none, the user's cache goes with the session.
async function confirmMountsSignOut(pending: number): Promise<boolean> {
	const options = {
		type: "warning" as const,
		buttons: [shellText("shellWait"), shellText("shellSignOut")],
		defaultId: 0,
		cancelId: 0,
		message: shellText("shellSignOutUploadingTitle"),
		detail: shellPlural("shellSignOutUploadingDetail", pending)
	}
	const { response } = await (mainWindow === null ? dialog.showMessageBox(options) : dialog.showMessageBox(mainWindow, options))

	return response === 1
}

// Where the network drive may not be, with the user's sync pairs.
async function mountPointContext(userId: string) {
	return { ...reservedDirectories(), pairRoots: (await syncStoreFor(userId)).get().pairs.map(pair => pair.localRoot) }
}

// A slow DNS answer for an old server's host name only turns that server off.
const LEGACY_HOST_LOOKUP_TIMEOUT_MS = 3000

// The old client's rclone, caches and mount settings (PLAN §6.7).
const legacyMounts = createLegacyMounts({
	userData: userDataPath,
	mountsDir: userId => path.join(mountsRoot, userId),
	owner: async () => legacyOwner(parseMarker((await migrationMarker.read())?.toString("utf8") ?? null)),
	binary: rclone?.binary ?? null,
	platform: process.platform,
	call: (op, args, userId, timeoutMs) => nativeSupervisor.callMounts(op, args, userId, timeoutMs),
	stash: migrationStash,
	storeFor: mountsStoreFor,
	credentialsFor: credentialStoreFor,
	mountPointContext,
	resolveHost: createHostResolver({ lookup, interfaces: () => os.networkInterfaces(), timeoutMs: LEGACY_HOST_LOOKUP_TIMEOUT_MS }),
	endLegacyDriveRclone: networkDrive =>
		endLegacyDriveRclone(
			{
				platform: PLATFORM,
				userData: userDataPath,
				env: process.env,
				run: runProgram,
				kill: (pid, signal) => process.kill(pid, signal),
				log: { info, warn }
			},
			networkDrive
		),
	log: { info, warn }
})

const mountsService = createMountsService({
	supervisor: nativeSupervisor,
	platform: process.platform,
	storeFor: mountsStoreFor,
	credentialsFor: credentialStoreFor,
	mountsDir: userId => path.join(mountsRoot, userId),
	logFile: path.join(userDataPath, "logs", "rclone.log"),
	binary: rclone?.binary ?? null,
	fuse: {
		status: () => fuseStatus(fuseContext),
		gap: () => (PLATFORM === "linux" ? linuxFuseGap(fuseContext) : null),
		install: PLATFORM === "win32" && fuseInstaller !== null ? () => installWinFsp(fuseContext, fuseInstaller) : null
	},
	certificate: ensureCertificate,
	interfaces: () => os.networkInterfaces(),
	tokens: createRootTokens(Date.now),
	dialogs: {
		showOpenDialog,
		mountPointContext,
		confirmSignOut: confirmMountsSignOut
	},
	shell: { openPath: target => shell.openPath(target) },
	clipboard: { writeText: text => clipboard.writeText(text) },
	legacy: legacyMounts,
	statusChanged: failed => {
		applyTray()
		notifyMountsFailed(failed)
	},
	now: Date.now,
	log: { info, warn }
})

// System Settings where extensions (File Providers among them) are switched on.
const FILE_PROVIDER_SETTINGS_URL = "x-apple.systempreferences:com.apple.ExtensionsPreferences"
const CLOUD_STORAGE = path.join(os.homedir(), "Library", "CloudStorage")

// Filen in Finder (macOS 14 and later): the addon loads only for a user who has it on, or to switch it off.
const fileProviderContext: FileProviderAddonContext = {
	packaged: app.isPackaged,
	resourcesPath: process.resourcesPath,
	appPath: app.getAppPath(),
	platform: process.platform,
	arch: process.arch,
	release: os.release(),
	execPath: process.execPath,
	exists: existsSync,
	load: file => createRequire(import.meta.url)(file)
}
let fileProviderSupport: boolean | undefined

function fileProviderSupported(): boolean {
	return (fileProviderSupport ??= fileProviderAddonPath(fileProviderContext) !== null)
}

const fileProvider = createFileProviderService({
	supported: fileProviderSupported,
	addon: createFileProviderAddon(fileProviderContext),
	vault: sessionVault,
	store: createFileProviderStore(userId => {
		const file = atomicFile(path.join(mountsRoot, userId, "fileProvider.json"))

		return {
			...file,
			write: async data => {
				await mountsDir(userId)
				await file.write(data)
			}
		}
	}, warn),
	clearOwed: atomicFile(path.join(userDataPath, "fileProvider.clearOwed")),
	pinSet: () => appLock?.status().enabled ?? true,
	translocated: () =>
		runsTranslocated({ packaged: app.isPackaged, inApplications: app.isInApplicationsFolder(), appPath: app.getAppPath() }),
	cloudStorage: {
		root: CLOUD_STORAGE,
		list: async () => {
			try {
				const entries = await readdir(CLOUD_STORAGE, { withFileTypes: true })

				return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					return []
				}

				throw error
			}
		}
	},
	openPath: target => shell.openPath(target),
	openSettings: () => shell.openExternal(FILE_PROVIDER_SETTINGS_URL),
	log: { info, warn }
})

// The session left the vault: rclone stops, then the host, then the user's local data goes (signOut.ts).
function signOut(userId: string | null): Promise<void> {
	return signOutFlow.signOut(userId)
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
const sessionEnd = createSessionEnd(source => {
	info(`quit: the OS session ends (${source}); no confirm`)
})
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
		warn("updater: nothing to install")
		quitting = false
		installingUpdate = false
	}
}

// The installer did not start (a declined elevation, Squirrel's error): the app keeps running and says so.
function updateInstallFailed(): void {
	quitting = false
	installingUpdate = false

	const options = {
		type: "warning" as const,
		message: shellText("shellUpdateFailedTitle"),
		detail: shellText("shellUpdateFailedDetail")
	}

	void (mainWindow === null ? dialog.showMessageBox(options) : dialog.showMessageBox(mainWindow, options))
}

// The window needs the app protocol and the migration; a show asked for before (activate, second-instance, the
// tray) is remembered and honoured once startup finished.
let started = false
let showRequested = false

// What the current page reported; a new page starts from nothing.
let unloadHolds = 0
let audioPlaying = false
let mediaTransport: DesktopMediaTransport = "none"
// The page listens for menu actions; until then clicked ones wait here.
let menuReady = false
let pendingMenuActions: DesktopMenuAction[] = []

function resetPageState(): void {
	unloadHolds = 0
	audioPlaying = false
	menuReady = false
	setMediaTransport("none")
	scheduleIdleDestroy()
}

// The Controls menu and the tray offer the transport only while the page has something queued.
function setMediaTransport(state: DesktopMediaTransport): void {
	if (state === mediaTransport) {
		return
	}

	mediaTransport = state
	applyMenu()
	applyTrayMenu()
}

function showWindow(): void {
	if (!started) {
		showRequested = true

		return
	}

	// Before anything shows again, so a window hidden through a sleep never shows its page unlocked.
	lockInactivity.check()

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
	const idle = () => {
		const { chatNotifications, contactNotifications } = currentPrefs()

		return (
			!window?.isVisible() &&
			!keepsRendererAlive({ unloadHolds, audioPlaying, socketNotifications: chatNotifications || contactNotifications })
		)
	}

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

	lockInactivity.rearm()
	applyMenu()
	applyTrayMenu()
}

function lockNow(): void {
	if (appLock?.lock() === true) {
		info("app lock: locked")
		lockChanged()
	}
}

// Pointer movement does not count: a pointer drifting across the window must not keep the app unlocked, and it is by
// far the noisiest input.
const PASSIVE_INPUT = new Set<string>(["mouseMove", "mouseEnter", "mouseLeave", "pointerMove", "pointerRawUpdate"])

function onInputEvent(_event: unknown, input: { type: string }): void {
	if (!PASSIVE_INPUT.has(input.type)) {
		lockInactivity.activity()
	}
}

// The contents the input listener is on; only while the lock can come, so without a PIN, while locked or under
// Never no input reaches JS at all.
let inputContents: WebContents | null = null

function listenForInput(listen: boolean): void {
	const contents = listen ? (mainWindow?.webContents ?? null) : null

	if (contents === inputContents) {
		return
	}

	if (inputContents !== null && !inputContents.isDestroyed()) {
		inputContents.off("input-event", onInputEvent)
	}

	inputContents = contents
	contents?.on("input-event", onInputEvent)
}

// "Lock after": no input in Filen's window for the chosen time, hidden time included. Never (0) still locks at launch,
// on Lock now and on the OS screen lock.
const lockInactivity = inactivityLock({
	lockAfterSeconds: () => currentPrefs().lockAfterSeconds,
	armed: canLock,
	lock: lockNow,
	listen: listenForInput
})

function hideWindow(window: BrowserWindow): void {
	// Hiding a fullscreen window leaves an empty fullscreen Space behind on macOS.
	if (window.isFullScreen()) {
		window.once("leave-full-screen", () => window.hide())
		window.setFullScreen(false)
	} else {
		window.hide()
	}
}

// The page's beforeunload asks to stay only while lib/unloadGuard.ts holds something (transfers, unsaved changes);
// main asks the same before quitting while native transfers run (no window when the idle one was destroyed).
function confirmUnload(window: BrowserWindow | null, action: string): boolean {
	if (window !== null && !window.isVisible()) {
		window.show()
	}

	const options = {
		type: "warning" as const,
		buttons: [action, shellText("shellCancel")],
		defaultId: 1,
		cancelId: 1,
		message: shellText("shellBusyTitle"),
		detail: shellText("shellBusyDetail")
	}

	return (window === null ? dialog.showMessageBoxSync(options) : dialog.showMessageBoxSync(window, options)) === 0
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
			app.getVersion(),
			fileProviderSupported()
		)
	)

	trackWindowState(window)

	// Development builds only: Windows and Linux have no View menu to hold the dev tools item. The page's own keys
	// (zoom, full screen, close) are the web keymap's, so they stay rebindable and a viewer can take them first.
	if (!app.isPackaged && PLATFORM !== "darwin") {
		window.webContents.on("before-input-event", (event, input) => {
			if (isDevToolsKey(input)) {
				event.preventDefault()
				window.webContents.toggleDevTools()
			}
		})
	}

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
		mountsService.pageGone(contentsId)
		transfersService.pageGone(contentsId)
	})
	window.webContents.on("destroyed", () => {
		syncService.pageGone(contentsId)
		mountsService.pageGone(contentsId)
		transfersService.pageGone(contentsId)
		dragOut.pageGone(contentsId)
	})
	// Before the old document goes: its unbegun drag sessions (and their downloads) end at once.
	window.webContents.on("did-start-navigation", details => {
		if (details.isMainFrame && !details.isSameDocument) {
			dragOut.pageGone(contentsId)
		}
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
		dragOut.pageGone(contentsId)

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

	sessionEnd.watchWindow(window)
	window.webContents.on("will-prevent-unload", event => {
		if (
			!unloadGuardAsks({ installingUpdate, sessionEnding: sessionEnd.ending() }) ||
			confirmUnload(window, shellText(quitting ? "shellBusyQuit" : "shellBusyLeave"))
		) {
			event.preventDefault()
		} else {
			quitting = false
			quitAfterDrag.reset()
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

	window.on("hide", scheduleIdleDestroy)
	window.on("show", () => {
		scheduleIdleDestroy()
		lockInactivity.check()
	})
	window.on("restore", () => {
		lockInactivity.check()
	})

	window.on("closed", () => {
		if (mainWindow === window) {
			mainWindow = null
			resetPageState()
			lockInactivity.rearm()
		}
	})

	mainWindow = window
	// The input listener moves to the new contents.
	lockInactivity.rearm()
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

// The audio transport from the tray or the Controls menu acts on the page that has the queue, without bringing the
// window up; with no page listening there is nothing queued to act on.
function runTransportAction(action: DesktopMenuAction): void {
	if (mainWindow !== null && menuReady && !isLocked()) {
		mainWindow.webContents.send(CHANNELS.menuAction, action)
	}
}

// File > Close: another of the app's windows closes itself; the page closes its open dialog first (a file preview),
// or the window when none is open. While it is locked or not listening, the window closes right away.
function closeFocusedWindow(): void {
	const focused = BrowserWindow.getFocusedWindow()

	if (focused !== null && focused !== mainWindow) {
		focused.close()

		return
	}

	if (mainWindow === null) {
		return
	}

	if (menuReady && !isLocked()) {
		mainWindow.webContents.send(CHANNELS.menuAction, "desktop.close")
	} else {
		mainWindow.close()
	}
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
						transport: mediaTransport,
						onAction: action => {
							if (TRANSPORT_ACTIONS.has(action)) {
								runTransportAction(action)
							} else {
								runMenuAction(action)
							}
						},
						onLock: canLock() ? lockNow : null,
						onClose: closeFocusedWindow,
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

// What the tray shows: sync's last aggregate while the host runs (or attention while a pair waits for the user), and
// what the mounts report.
let syncAggregate: NativeAggregate = "idle"
let syncHeld = false
// Sync's own state, for its notification; the icon shows the more urgent of sync and mounts.
let syncTray: TrayState = "idle"
let trayIcon: TrayState = "idle"
let trayLines: string[] = []
let trayDrive: string | null = null
let syncAttentionPair: string | null = null
// Held so it is not collected before it is clicked.
let notification: Notification | null = null
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

// Sync and mount alerts, only while the user is elsewhere and wants them.
function notify(body: string, onClick: () => void): void {
	const { syncNotifications, notificationSound } = currentPrefs()

	if (!syncNotifications || BrowserWindow.getFocusedWindow() !== null || !Notification.isSupported()) {
		return
	}

	notification = new Notification({ title: "Filen", body, silent: !notificationSound })
	notification.on("click", () => {
		notification = null
		showWindow()
		onClick()
	})
	notification.show()
}

// The click opens the pair that asked last.
function notifySyncAttention(host: DesktopSyncHostState): void {
	const pairId = host.state === "failed" ? null : syncAttentionPair

	notify(shellText(host.state === "failed" ? "shellNotifySyncStopped" : "shellNotifySyncAttention"), () => {
		if (pairId !== null) {
			openSyncPair(pairId)
		}
	})
}

function notifyMountsFailed(roles: readonly DesktopMountsRole[]): void {
	if (roles.length > 0) {
		notify(roleFailureMessage(roles), () => undefined)
	}
}

function applyTray(): void {
	const host = nativeSupervisor.state()
	const mounts = mountsService.trayView()
	const sync = syncHeld ? "attention" : syncAggregate
	const nextSync = trayState(sync, "idle", host)
	const nextIcon = trayState(sync, mounts.aggregate, host)
	const lines = trayStatusLines(sync, mounts.aggregate, host, mounts.mountPoint)
	const previousSync = syncTray

	syncTray = nextSync

	// Activity names the pair before the aggregate turns; it is forgotten once the attention is over.
	if (previousSync === "attention" && nextSync !== "attention") {
		syncAttentionPair = null
	}

	if (tray !== null && nextIcon !== trayIcon) {
		tray.setImage(trayImage(nextIcon))
	}

	trayIcon = nextIcon

	if (lines.join("\n") !== trayLines.join("\n") || mounts.mountPoint !== trayDrive) {
		trayLines = lines
		trayDrive = mounts.mountPoint
		tray?.setToolTip(trayTooltip(lines))
		applyTrayMenu()
	}

	if (attentionTransitions(previousSync, nextSync)) {
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
			...trayLines.map(label => ({ label, enabled: false })),
			...(trayDrive === null
				? []
				: [
						{
							label: shellText("shellOpenNetworkDrive"),
							click: () => {
								void mountsService.revealDrive()
							}
						}
					]),
			...(trayLines.length === 0 ? [] : [{ type: "separator" as const }]),
			...transportItems(mediaTransport).map(({ action, label }) => ({
				label,
				click: () => {
					runTransportAction(action)
				}
			})),
			...(mediaTransport === "none" ? [] : [{ type: "separator" as const }]),
			{ label: shellText("shellOpen"), click: showWindow },
			...(canLock() ? [{ label: shellText("shellLock"), click: lockNow }] : []),
			{ type: "separator" },
			{ label: shellText("shellQuit"), click: () => app.quit() }
		])
	)
}

function createTray(): void {
	tray = new Tray(trayImage(trayIcon))
	tray.setToolTip(trayTooltip(trayLines))
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
		title: shellText("shellExportLogsTitle"),
		defaultPath: path.join(app.getPath("downloads"), `filen-desktop-logs-${stamp}.txt`),
		filters: [{ name: shellText("shellTextFiles"), extensions: ["txt"] }]
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

const instanceLock = acquireInstanceLock({
	request: () => app.requestSingleInstanceLock(),
	relaunched: process.env[UPDATER_RELAUNCH_ENV] === "true",
	now: Date.now,
	sleep: ms => {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
	}
})

if (!instanceLock.held) {
	info(
		`another instance holds the single-instance lock${instanceLock.attempts > 1 ? ` (waited ${String(instanceLock.waitedMs)} ms)` : ""}; quitting`
	)
	// Electron tears down next; a batched line would never reach the disk.
	fileLog.flushSync()
	app.quit()
} else {
	if (instanceLock.attempts > 1) {
		info(`single-instance lock taken after ${String(instanceLock.waitedMs)} ms (the previous instance was quitting)`)
	}

	// The main module runs to its end before Electron creates the default session and emits ready, so nothing holds the
	// profile's storage open yet. Synchronous, so it is done before that.
	profileWipe = wipeProfileBeforeReady({
		readMarker: () => {
			try {
				return readFileSync(signOutMarkerPath, "utf8")
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					return null
				}

				throw error
			}
		},
		sessionStored: () => existsSync(sessionVaultPath),
		deleteProfile: () => {
			deleteProfileStorage(userDataPath)
		}
	})
	earlyPurge = purgeBeforeReady({
		readMarker: () => {
			try {
				return readFileSync(migrationMarkerPath, "utf8")
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					return null
				}

				throw error
			}
		},
		deleteStores: () => {
			deleteLegacyStores(userDataPath)
		}
	})
	void signOutFlow.resume().then(signOutResumed.resolve)
	// A quitting app opens no window: the updater's relaunch asks for the lock while this one stops its native host.
	app.on("second-instance", () => {
		if (!quitting) {
			showWindow()
		}
	})
	// Native transfers hold no page unload guard: main asks itself. Quit never waits for them; will-quit stops the host,
	// which aborts them. A running OS drag defers the quit (and the prompt) until it ends.
	app.on("before-quit", event => {
		if (quitAfterDrag.defer()) {
			event.preventDefault()
			info("quit: waiting for the drag out to end")

			return
		}

		if (
			shouldConfirmQuit({
				unloadHolds,
				nativeTransfers: transfersService.active(),
				installingUpdate,
				confirmed: quitting,
				sessionEnding: sessionEnd.ending()
			})
		) {
			if (!confirmUnload(mainWindow, shellText("shellBusyQuit"))) {
				event.preventDefault()
				info("quit: canceled while native transfers run")

				return
			}

			info("quit: stopping native transfers")
		}

		if (!quitting) {
			info("quit: closing windows")
		}

		quitting = true
	})
	// After the windows closed (and the page's unload guard agreed): the native host closes its engine first.
	app.on("will-quit", event => {
		// The windows closed and the page agreed: drags end (Finder's waiting writes and Explorer's reads fail) before
		// the host stops; their temp goes once it has.
		dragOut.quit()

		if (nativeSupervisor.active()) {
			event.preventDefault()
			info("quit: stopping the native host")
			void nativeSupervisor.stop().finally(() => {
				info("quit: native host stopped")
				app.quit()
			})

			return
		}

		dragTemp.removeAllSync()
		// Electron tears down next; a batched line would never reach the disk.
		info("quit: shutting down")
		fileLog.flushSync()
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

		const userId = sessionUserId(blob)

		if (userId !== null) {
			await signOutFlow.signedIn(userId)
		}

		await sessionVault.set(blob)
		nativeSupervisor.sessionChanged(blob)
		void fileProvider.sessionChanged(blob)
		void migration.sessionConfirmed(blob)
	})
	handle(CHANNELS.sessionClear, async () => {
		const user = await nativeSupervisor.user()

		// Listed before the session goes, so a sign-out cut short from here on still has its page's wipes finished.
		await signOutFlow.begin()

		try {
			await sessionVault.clear()
		} finally {
			await signOut(user?.userId ?? null)
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

		const previous = store.get().lockAfterSeconds
		const next = await store.set(patch)

		scheduleIdleDestroy()

		if (next.lockAfterSeconds !== previous) {
			lockInactivity.rearm()
		}

		return next
	})

	ipcMain.on(CHANNELS.showWindow, event => {
		if (isTrusted(event.senderFrame)) {
			showWindow()
		}
	})

	ipcMain.on(CHANNELS.networkOnline, event => {
		if (isTrusted(event.senderFrame)) {
			nativeSupervisor.reconnectSocket()
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

	ipcMain.on(CHANNELS.setMediaTransport, (event, payload: unknown) => {
		const state = mediaTransportSchema(payload)

		if (isTrusted(event.senderFrame) && !(state instanceof type.errors) && mainWindow?.webContents === event.sender) {
			setMediaTransport(state)
		}
	})

	ipcMain.on(CHANNELS.quit, event => {
		if (isTrusted(event.senderFrame)) {
			app.quit()
		}
	})

	ipcMain.on(CHANNELS.windowZoom, (event, payload: unknown) => {
		const step = zoomStepSchema(payload)

		if (isTrusted(event.senderFrame) && !(step instanceof type.errors)) {
			event.sender.setZoomLevel(zoomLevelAfter(event.sender.getZoomLevel(), step))
		}
	})

	ipcMain.on(CHANNELS.windowToggleFullScreen, event => {
		const window = BrowserWindow.fromWebContents(event.sender)

		if (isTrusted(event.senderFrame) && window !== null) {
			window.setFullScreen(!window.isFullScreen())
		}
	})

	ipcMain.on(CHANNELS.windowClose, event => {
		const window = BrowserWindow.fromWebContents(event.sender)

		if (isTrusted(event.senderFrame) && window !== null) {
			window.close()
		}
	})

	ipcMain.on(CHANNELS.setShellStrings, (event, payload: unknown) => {
		if (!isTrusted(event.senderFrame) || !applyShellStrings(payload, shellStringsFile, warn)) {
			return
		}

		applyMenu()
		applyTray()
		applyTrayMenu()
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
		if ((unloadHolds > 0 || transfersService.active() > 0) && !confirmUnload(window, shellText("shellBusyRestart"))) {
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

		if (result.ok) {
			await fileProvider.pinChanged()
		}

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
		const user = await nativeSupervisor.user()

		await sessionVault.clear()
		await signOut(user?.userId ?? null)
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
	registerMountsIpc(ipcMain, mountsService, url => isTrustedSender(url, APP_ORIGIN))
	registerTransfersIpc(ipcMain, transfersService, url => isTrustedSender(url, APP_ORIGIN))
	registerDragOutIpc(ipcMain, dragOut, url => isTrustedSender(url, APP_ORIGIN))
	registerFileProviderIpc(ipcMain, fileProvider, url => isTrustedSender(url, APP_ORIGIN))
	registerSessionRecoveryIpc(ipcMain, discardUnreadableSession, url => isTrustedSender(url, APP_ORIGIN))
	// The session exists only after ready, which every page call comes after.
	registerBrowserCacheIpc(
		ipcMain,
		sessionBrowserCache(() => session.defaultSession),
		url => isTrustedSender(url, APP_ORIGIN)
	)

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

				updater = startUpdater({
					log: { info, warn },
					testFeed,
					load: async () => {
						const engine: UpdaterEngine = (await import("electron-updater")).autoUpdater

						return engine
					},
					native:
						PLATFORM === "darwin"
							? events => {
									squirrel.on("update-downloaded", events.downloaded)
									squirrel.on("error", events.error)
								}
							: null,
					onReady: version => {
						info(`updater: ${version} is ready to install`)

						if (testFeed !== null) {
							installUpdateNow()
						} else {
							mainWindow?.webContents.send(CHANNELS.updateReady, version)
						}
					},
					onInstallFailed: updateInstallFailed
				})
			}
		})
		.catch((error: unknown) => {
			warn(`updater did not start: ${error instanceof Error ? error.message : String(error)}`)
		})

	app.whenReady()
		.then(async () => {
			prefs = await prefsLoading
			await shellStringsLoading
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

			// A sleep stops the inactivity timer; the screen lock is a moment to lock too, under Never as well.
			powerMonitor.on("resume", lockInactivity.check)
			// The network comes back after a sleep: the sync engine's socket reconnects now instead of waiting out its
			// backoff. The page's `online` events reach it through CHANNELS.networkOnline.
			powerMonitor.on("resume", () => {
				nativeSupervisor.reconnectSocket()
			})
			powerMonitor.on("unlock-screen", lockInactivity.check)
			powerMonitor.on("lock-screen", lockNow)
			sessionEnd.watchPowerMonitor(powerMonitor)

			// Without its headers the web app cannot run (no cross-origin isolation, no CSP), so a missing file is fatal.
			if (webDevServer === undefined) {
				registerAppProtocol(SCHEME, webDist, parseHeaders(readFileSync(path.join(webDist, "_headers"), "utf8")))
			} else {
				registerDevProxy(SCHEME, webDevServer)
			}

			// The profile's files went before ready; Chromium's own removal catches what that list does not name.
			if (profileWipe.result === "deleted") {
				await Promise.all([
					defaultSession.clearData(),
					defaultSession.clearStorageData(),
					defaultSession.clearCodeCaches({})
				]).catch((error: unknown) => {
					warn(`sign-out: browser data not cleared: ${errorCode(error)}`)
				})
			}

			hostProxy = resolveHostProxy({
				env: process.env,
				resolve: url => defaultSession.resolveProxy(url),
				log: { info, warn },
				waitMs: PROXY_RESOLVE_WAIT_MS
			})

			// Before the first window, so the page boots with the imported session, PIN and prefs.
			if ((await migration.start()).pinImported) {
				lockNow()
			}

			// The migration may have stored a lock-after choice, past the prefs handler.
			lockInactivity.rearm()

			// What an unclean exit left of downloads in flight, before a host can start new ones beside it.
			await transfersJournal.sweep()
			// What an earlier run's drags left (older than an hour, so another instance's live ones stay).
			void dragTemp.sweep(3_600_000)

			started = true
			nativeSupervisor.ensure("launch")
			void fileProvider.launch()

			const openedAtLogin = PLATFORM === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin

			if (showRequested || !startsHidden(process.argv, prefs.get().startMinimized, openedAtLogin)) {
				showWindow()
			}
		})
		.catch((error: unknown) => {
			dialog.showErrorBox("Filen", `${shellText("shellStartFailed")}\n\n${error instanceof Error ? error.message : String(error)}`)
			app.exit(1)
		})
}
