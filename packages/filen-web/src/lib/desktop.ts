import type { DesktopBridge, DesktopPlatform } from "@filen/shared/desktop"

// The one reader of window.desktop. The preload defines it before any page script runs, so it never
// appears or disappears mid-session and is read once.
const bridge = window.desktop

// CSS keys the desktop window chrome off these attributes (index.css), so layouts need no JS for them:
// data-desktop is the platform, data-window-fullscreen marks native fullscreen (no traffic lights), and
// data-window-border asks for the page-drawn border on a Windows 10 window that is not maximized or snapped.
if (bridge !== undefined) {
	const root = document.documentElement

	root.dataset["desktop"] = bridge.platform

	bridge.onWindowState(state => {
		root.toggleAttribute("data-window-fullscreen", state.fullScreen)
		root.toggleAttribute("data-window-border", state.drawsBorder && !state.maximized && !state.fullScreen && !state.snapped)
	})
}

export function desktopBridge(): DesktopBridge | undefined {
	return bridge
}

export function desktopPlatform(): DesktopPlatform | undefined {
	return bridge?.platform
}

// The theme tokens are oklch() and some are translucent, which window chrome cannot take: resolve each token to
// opaque rgb by painting one pixel over the canvas colour.
function resolveColor(context: CanvasRenderingContext2D, styles: CSSStyleDeclaration, token: string): string {
	context.fillStyle = styles.getPropertyValue("--canvas").trim()
	context.fillRect(0, 0, 1, 1)
	context.fillStyle = styles.getPropertyValue(token).trim()
	context.fillRect(0, 0, 1, 1)

	return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3)).join(", ")})`
}

// Windows and Linux draw minimize/maximize/close over the top band, and Windows 11 a border around the window;
// keep them on the theme's colours.
export function syncTitleBarColors(): void {
	if (bridge === undefined || bridge.platform === "darwin") {
		return
	}

	const canvas = document.createElement("canvas")
	canvas.width = 1
	canvas.height = 1
	const context = canvas.getContext("2d", { willReadFrequently: true })

	if (context === null) {
		return
	}

	const styles = getComputedStyle(document.documentElement)

	bridge.setTitleBarColors({
		color: resolveColor(context, styles, "--canvas"),
		symbolColor: resolveColor(context, styles, "--muted-foreground"),
		border: resolveColor(context, styles, "--shell-border")
	})
}
