import type { DesktopPlatform } from "@filen/shared/desktop"

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
