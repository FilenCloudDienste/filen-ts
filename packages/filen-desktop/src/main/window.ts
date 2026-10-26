import type { BrowserWindowConstructorOptions } from "electron"
import type { DesktopPlatform, TitleBarColors } from "@filen/shared/desktop"

// filen-web's --canvas and --muted-foreground in rgb, so the window paints the right colour before the page
// does; the page then keeps the overlay in sync with its theme (syncTitleBarColors).
export function initialColors(dark: boolean): TitleBarColors {
	return dark
		? { color: "rgb(7, 7, 7)", symbolColor: "rgb(161, 161, 161)" }
		: { color: "rgb(230, 230, 230)", symbolColor: "rgb(99, 99, 99)" }
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
			: { titleBarOverlay: { ...colors, height: TITLE_BAR_OVERLAY_HEIGHT } }),
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
