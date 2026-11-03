import type { DesktopPlatform } from "@filen/shared/desktop"
import { SHUTDOWN_TIMEOUT_MS } from "./native/supervisor.ts"

// How long a hidden window keeps its page before main destroys it to free the renderer's memory. Reopening reboots
// the web app (bundle, wasm compile, cache restore, socket reconnect), so a window hidden for a moment keeps it.
export const IDLE_DESTROY_DELAY_MS = 3 * 60 * 1000

// Passed by the login item: start in the tray (or dock) without a window.
export const HIDDEN_ARG = "--hidden"

// What the window's close button does: macOS hides (the dock reopens it), Windows and Linux quit unless the app
// lives on in the tray. Once a quit is under way the window really closes.
export function closeAction(platform: DesktopPlatform, quitting: boolean, minimizeToTray: boolean): "close" | "hide" | "quit" {
	if (quitting) {
		return "close"
	}

	return platform === "darwin" || minimizeToTray ? "hide" : "quit"
}

export interface RendererKeepAlive {
	// lib/unloadGuard.ts holds: transfers, unsaved editors and the like.
	unloadHolds: number
	audioPlaying: boolean
	// The page owns the chat socket the notifications come from.
	notifications: boolean
}

export function keepsRendererAlive({ unloadHolds, audioPlaying, notifications }: RendererKeepAlive): boolean {
	return unloadHolds > 0 || audioPlaying || notifications
}

// No window at startup: launched at login, or the user asked to start minimized.
export function startsHidden(argv: readonly string[], startMinimized: boolean, openedAtLogin: boolean): boolean {
	return startMinimized || openedAtLogin || argv.includes(HIDDEN_ARG)
}

// The packaged name and userData directory are the old client's, kept for the migration and the keychain. The name
// keys the safeStorage entry ("<name> Safe Storage" in the macOS keychain and the Linux keyring), so unpackaged runs
// get their own name and directory: an ad-hoc signed build owning the signed app's entry makes that app prompt for the
// password, and development never touches a real installation.
export function appIdentity(packaged: boolean): { name: string; userData: string } {
	return packaged ? { name: "Filen", userData: "@filen/desktop" } : { name: "Filen Dev", userData: "@filen/desktop-dev" }
}

// electron-updater's AppImage install starts the new AppImage with this set to "true" before the old instance quits,
// and the old one holds the single-instance lock while its native host stops.
export const UPDATER_RELAUNCH_ENV = "APPIMAGE_SILENT_INSTALL"
// How long that relaunch waits for the lock, and how often it asks again. The quitting instance's will-quit stops the
// native host behind whatever the supervisor's queue holds: a stop already under way (a session change), then its own,
// each up to SHUTDOWN_TIMEOUT_MS, then the windows' teardown and the exit.
export const RELAUNCH_LOCK_WAIT_MS = 2 * SHUTDOWN_TIMEOUT_MS + 10_000
export const RELAUNCH_LOCK_RETRY_MS = 250

export interface InstanceLockContext {
	request(): boolean
	// Started by the updater, so the instance holding the lock is quitting.
	relaunched: boolean
	now(): number
	// Blocking: the lock decides what runs before ready.
	sleep(ms: number): void
}

// The single-instance lock: asked once, or, for the updater's relaunch, until the quitting instance lets go of it.
export function acquireInstanceLock(context: InstanceLockContext): { held: boolean; attempts: number; waitedMs: number } {
	const start = context.now()
	let attempts = 0

	for (;;) {
		attempts++

		if (context.request()) {
			return { held: true, attempts, waitedMs: context.now() - start }
		}

		if (!context.relaunched || context.now() - start >= RELAUNCH_LOCK_WAIT_MS) {
			return { held: false, attempts, waitedMs: context.now() - start }
		}

		context.sleep(RELAUNCH_LOCK_RETRY_MS)
	}
}
