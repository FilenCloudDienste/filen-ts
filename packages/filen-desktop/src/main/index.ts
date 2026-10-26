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
	protocol,
	safeStorage,
	session,
	shell,
	Tray,
	type WebFrameMain
} from "electron"
import { readFileSync } from "node:fs"
import { type } from "arktype"
import path from "node:path"
import type { DesktopMenuAction, DesktopPlatform, WindowState } from "@filen/shared/desktop"
import { CHANNELS } from "../shared/channels.ts"
import { atomicFile } from "./atomicFile.ts"
import { autostartFile, setAutostart } from "./autostart.ts"
import { BADGE_DOT_SIZE, badgeDotBitmap } from "./badge.ts"
import { parseHeaders } from "./headers.ts"
import { closeAction, HIDDEN_ARG, IDLE_DESTROY_DELAY_MS, keepsRendererAlive, startsHidden } from "./lifecycle.ts"
import { isMenuAction, type MenuShortcuts, menuTemplate } from "./menu.ts"
import { classifyNavigation, isTrustedSender } from "./navigation.ts"
import { isPermissionAllowed } from "./permissions.ts"
import { DEFAULT_PREFS, loadPrefs, prefsPatchSchema, type PrefsStore } from "./prefs.ts"
import { registerAppProtocol } from "./serve.ts"
import { createSessionVault, isSessionBlob, vaultMode, type VaultCipher } from "./sessionVault.ts"
import { drawsOwnBorder, initialColors, windowOptions } from "./window.ts"

// Payloads from the renderer are untrusted input.
const titleBarColorsSchema = type({ color: "string", symbolColor: "string", border: "string" })
const countSchema = type("0 <= number.integer < 1000000")
const audioPlayingSchema = type("boolean")
const menuShortcutsSchema = type({ "[string]": "string <= 64" })

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

protocol.registerSchemesAsPrivileged([
	{
		scheme: SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
			codeCache: true,
			allowServiceWorkers: true
		}
	}
])

// Packaged builds carry the web build as a resource; development serves filen-web's own dist or FILEN_DESKTOP_WEB_DIST.
const webDist = app.isPackaged
	? path.join(process.resourcesPath, "web")
	: path.resolve(process.env["FILEN_DESKTOP_WEB_DIST"] ?? path.join(app.getAppPath(), "../filen-web/dist"))

// Probed on first use, after app ready: safeStorage reports nothing useful before it.
async function sessionCipher(): Promise<VaultCipher | null> {
	const backend = PLATFORM === "linux" ? safeStorage.getSelectedStorageBackend() : ""

	if (vaultMode(PLATFORM, backend, await safeStorage.isAsyncEncryptionAvailable()) === "memory") {
		console.warn(`session vault: no secure storage (${backend || "unavailable"}); keeping the session in memory only`)

		return null
	}

	return {
		encrypt: plain => safeStorage.encryptStringAsync(plain),
		decrypt: encrypted => safeStorage.decryptStringAsync(encrypted)
	}
}

function warn(message: string): void {
	console.warn(message)
}

const sessionVault = createSessionVault(sessionCipher, atomicFile(path.join(app.getPath("userData"), "session.vault")), warn)

// Read before ready; the window and every pref-dependent decision come after ready, once this has settled.
const prefsLoading = loadPrefs(atomicFile(path.join(app.getPath("userData"), "prefs.json")), warn)
let prefs: PrefsStore | null = null

function currentPrefs() {
	return prefs?.get() ?? DEFAULT_PREFS
}

let mainWindow: BrowserWindow | null = null
let quitting = false
// activate and second-instance can fire before the app protocol exists; the window waits for it.
let started = false

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
		return
	}

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
function confirmUnload(window: BrowserWindow): boolean {
	if (!window.isVisible()) {
		window.show()
	}

	const choice = dialog.showMessageBoxSync(window, {
		type: "warning",
		buttons: [quitting ? "Quit" : "Leave", "Cancel"],
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
	window.webContents.on("render-process-gone", resetPageState)

	window.webContents.on("will-prevent-unload", event => {
		if (confirmUnload(window)) {
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

	window.on("hide", scheduleIdleDestroy)
	window.on("show", scheduleIdleDestroy)

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

function createTray(): void {
	const directory = app.isPackaged ? path.join(process.resourcesPath, "tray") : path.join(app.getAppPath(), "build", "tray")
	const file = PLATFORM === "darwin" ? "trayTemplate.png" : PLATFORM === "win32" ? "tray.ico" : "tray.png"

	tray = new Tray(nativeImage.createFromPath(path.join(directory, file)))
	tray.setToolTip("Filen")
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Open Filen", click: showWindow },
			{ type: "separator" },
			{ label: "Quit Filen", click: () => app.quit() }
		])
	)
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
	app.on("activate", showWindow)
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
	handle(CHANNELS.sessionSet, blob => {
		if (!isSessionBlob(blob)) {
			throw new Error("invalid session")
		}

		return sessionVault.set(blob)
	})
	handle(CHANNELS.sessionClear, () => sessionVault.clear())

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

	app.whenReady()
		.then(async () => {
			prefs = await prefsLoading
			applyMenu()
			createTray()

			const { defaultSession } = session

			defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
				callback(isPermissionAllowed(permission, details.requestingUrl, APP_ORIGIN))
			})
			defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
				isPermissionAllowed(permission, requestingOrigin, APP_ORIGIN)
			)

			// Without its headers the web app cannot run (no cross-origin isolation, no CSP), so a missing file is fatal.
			registerAppProtocol(SCHEME, webDist, parseHeaders(readFileSync(path.join(webDist, "_headers"), "utf8")))
			started = true

			const openedAtLogin = PLATFORM === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin

			if (!startsHidden(process.argv, prefs.get().startMinimized, openedAtLogin)) {
				showWindow()
			}
		})
		.catch((error: unknown) => {
			dialog.showErrorBox("Filen", `Filen could not start.\n\n${error instanceof Error ? error.message : String(error)}`)
			app.exit(1)
		})
}
