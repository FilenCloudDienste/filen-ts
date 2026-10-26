import type { BrowserWindowConstructorOptions } from "electron"
import type { DesktopPlatform, TitleBarColors } from "@filen/shared/desktop"

// filen-web's --canvas, --muted-foreground and --shell-border (blended over the canvas) in rgb, so the window paints
// the right colours before the page does; the page then keeps them in sync with its theme (syncTitleBarColors).
export function initialColors(dark: boolean): TitleBarColors {
	return dark
		? { color: "rgb(7, 7, 7)", symbolColor: "rgb(161, 161, 161)", border: "rgb(24, 24, 24)" }
		: { color: "rgb(230, 230, 230)", symbolColor: "rgb(99, 99, 99)", border: "rgb(202, 202, 202)" }
}

// Windows 11 (build 22000) rounds and borders frameless windows itself; Windows 10 draws neither, and rounding there
// would need a transparent window, which loses edge resizing and maximize. So Windows 10 gets a page-drawn border.
export function drawsOwnBorder(platform: DesktopPlatform, systemVersion: string): boolean {
	return platform === "win32" && Number(systemVersion.split(".")[2] ?? 0) < 22000
}

// The web reserves this band through env(titlebar-area-height) on Windows and Linux.
export const TITLE_BAR_OVERLAY_HEIGHT = 32

// macOS: the lights sit centred in the web's 64px icon rail (iconRail.tsx), above the brand.
const TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 }

export function windowOptions(
	platform: DesktopPlatform,
	colors: TitleBarColors,
	preload: string,
	devTools: boolean
): BrowserWindowConstructorOptions {
	return {
		width: 1280,
		height: 800,
		minWidth: 800,
		minHeight: 560,
		show: false,
		title: "Filen",
		backgroundColor: colors.color,
		titleBarStyle: "hidden",
		...(platform === "darwin"
			? { trafficLightPosition: TRAFFIC_LIGHT_POSITION }
			: { titleBarOverlay: { color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_OVERLAY_HEIGHT } }),
		...(platform === "win32" ? { accentColor: colors.border } : {}),
		webPreferences: {
			preload,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			spellcheck: false,
			devTools
		}
	}
}
