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
	setTitleBarColors(colors: TitleBarColors): void
	// Calls back with the current state right away when it is known, then on every change. Returns the unsubscribe.
	onWindowState(callback: (state: WindowState) => void): () => void
	// Shows and focuses the window (a clicked notification).
	showWindow(): void
}
