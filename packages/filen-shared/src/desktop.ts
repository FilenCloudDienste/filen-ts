// The contract between the Filen web app and the desktop shell's preload, exposed as `window.desktop`.
// Types only: the browser build pays nothing for it, and an absent `window.desktop` means a plain browser.

export type DesktopPlatform = "darwin" | "win32" | "linux"

// Colours for the window-controls overlay that Windows and Linux draw top-right (CSS colour strings).
export interface TitleBarColors {
	color: string
	symbolColor: string
}

// The SDK session kept by the shell in the OS keychain-backed vault instead of web storage. `blob` is the session as
// the web's envelope JSON (bigint-safe); the shell checks its shape and never reads the keys.
export interface DesktopSessionVault {
	// null only when no session is stored. Rejects when one is stored but cannot be read (locked keychain, changed
	// desktop environment): that is not a sign-out, so the caller must not clear anything.
	get(): Promise<string | null>
	set(blob: string): Promise<void>
	clear(): Promise<void>
}

export interface DesktopBridge {
	readonly platform: DesktopPlatform
	readonly session: DesktopSessionVault
	setTitleBarColors(colors: TitleBarColors): void
}
