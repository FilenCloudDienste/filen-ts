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
}

export interface DesktopBridge {
	readonly platform: DesktopPlatform
	readonly session: DesktopSessionVault
	readonly prefs: DesktopPrefsStore
	readonly app: DesktopApp
	setTitleBarColors(colors: TitleBarColors): void
	// Calls back with the current state right away when it is known, then on every change. Returns the unsubscribe.
	onWindowState(callback: (state: WindowState) => void): () => void
	// Shows and focuses the window (a clicked notification).
	showWindow(): void
}
