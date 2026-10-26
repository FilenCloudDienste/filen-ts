// The contract between the Filen web app and the desktop shell's preload, exposed as `window.desktop`.
// Types only: the browser build pays nothing for it, and an absent `window.desktop` means a plain browser.

export type DesktopPlatform = "darwin" | "win32" | "linux"

// Colours for the window-controls overlay that Windows and Linux draw top-right (CSS colour strings).
export interface TitleBarColors {
	color: string
	symbolColor: string
}

export interface DesktopBridge {
	readonly platform: DesktopPlatform
	setTitleBarColors(colors: TitleBarColors): void
}
