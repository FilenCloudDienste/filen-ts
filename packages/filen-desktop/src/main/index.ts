import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, nativeTheme, protocol, safeStorage, session, shell } from "electron"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { DesktopPlatform, WindowState } from "@filen/shared/desktop"
import { CHANNELS } from "../shared/channels.ts"
import { parseHeaders } from "./headers.ts"
import { classifyNavigation, isTrustedSender } from "./navigation.ts"
import { isPermissionAllowed } from "./permissions.ts"
import { registerAppProtocol } from "./serve.ts"
import { createSessionVault, isSessionBlob, vaultFile, vaultMode, type VaultCipher } from "./sessionVault.ts"
import { drawsOwnBorder, initialColors, windowOptions } from "./window.ts"

const SCHEME = "filen"
const APP_ORIGIN = `${SCHEME}://app`
const PLATFORM = process.platform as DesktopPlatform

// The old client's userData lives under the package name; pinning it keeps it for the migration and the keychain.
// Unpackaged runs get their own directory so development never touches a real installation.
app.setPath("userData", path.join(app.getPath("appData"), app.isPackaged ? "@filen/desktop" : "@filen/desktop-dev"))
app.setName("Filen")

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

const sessionVault = createSessionVault(sessionCipher, vaultFile(path.join(app.getPath("userData"), "session.vault")), message => {
	console.warn(message)
})

let mainWindow: BrowserWindow | null = null
let quitting = false
// activate and second-instance can fire before the app protocol exists; the window waits for it.
let started = false

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

function createWindow(): void {
	const window = new BrowserWindow(
		windowOptions(
			PLATFORM,
			initialColors(nativeTheme.shouldUseDarkColors),
			path.join(import.meta.dirname, "preload.cjs"),
			!app.isPackaged
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

	window.once("ready-to-show", () => window.show())

	// macOS keeps the app running when the window closes; the dock icon brings it back.
	window.on("close", event => {
		if (PLATFORM === "darwin" && !quitting) {
			event.preventDefault()

			// Hiding a fullscreen window leaves an empty fullscreen Space behind.
			if (window.isFullScreen()) {
				window.once("leave-full-screen", () => window.hide())
				window.setFullScreen(false)
			} else {
				window.hide()
			}
		}
	})

	window.on("closed", () => {
		if (mainWindow === window) {
			mainWindow = null
		}
	})

	mainWindow = window
	void window.loadURL(`${APP_ORIGIN}/`)
}

if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on("second-instance", showWindow)
	app.on("before-quit", () => {
		quitting = true
	})
	app.on("activate", showWindow)
	app.on("window-all-closed", () => {
		if (PLATFORM !== "darwin") {
			app.quit()
		}
	})

	ipcMain.on(CHANNELS.setTitleBarColors, (event, colors: unknown) => {
		if (!isTrustedSender(event.senderFrame?.url, APP_ORIGIN) || PLATFORM === "darwin") {
			return
		}

		if (
			typeof colors === "object" &&
			colors !== null &&
			"color" in colors &&
			"symbolColor" in colors &&
			"border" in colors &&
			typeof colors.color === "string" &&
			typeof colors.symbolColor === "string" &&
			typeof colors.border === "string"
		) {
			const window = BrowserWindow.fromWebContents(event.sender)

			window?.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor })

			// Windows 11 draws the border in this colour (a no-op on Windows 10, which gets the page's border).
			if (PLATFORM === "win32") {
				window?.setAccentColor(colors.border)
			}
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

	app.whenReady()
		.then(() => {
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
			showWindow()
		})
		.catch((error: unknown) => {
			dialog.showErrorBox("Filen", `Filen could not start.\n\n${error instanceof Error ? error.message : String(error)}`)
			app.exit(1)
		})
}
