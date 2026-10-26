import type { DesktopBridge, DesktopPlatform } from "@filen/shared/desktop"

// The one reader of window.desktop. The preload defines it before any page script runs, so it never
// appears or disappears mid-session and is read once.
const bridge = window.desktop

// CSS keys the desktop window-chrome insets off this attribute (index.css), so layouts need no JS for them.
if (bridge !== undefined) {
	document.documentElement.dataset["desktop"] = bridge.platform
}

export function desktopBridge(): DesktopBridge | undefined {
	return bridge
}

export function desktopPlatform(): DesktopPlatform | undefined {
	return bridge?.platform
}

// The theme tokens are oklch(), which the window-controls overlay may not parse: resolve each token to
// rgb by painting one pixel.
function resolveColor(context: CanvasRenderingContext2D, token: string): string {
	context.clearRect(0, 0, 1, 1)
	context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
	context.fillRect(0, 0, 1, 1)

	return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3)).join(", ")})`
}

// Windows and Linux draw minimize/maximize/close over the top band; keep them on the canvas colours.
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

	bridge.setTitleBarColors({ color: resolveColor(context, "--canvas"), symbolColor: resolveColor(context, "--muted-foreground") })
}
