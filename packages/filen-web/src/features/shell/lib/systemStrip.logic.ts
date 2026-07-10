// Pure platform-layout decision for the desktop system strip — framework-free so darwin/win32/linux
// and the maximize-icon toggle are exhaustively table-tested without mounting the component or
// stubbing window.desktop. SystemStrip.tsx owns the DesktopBridge subscription; this module only
// turns its inputs into layout facts.

// Mirrors DesktopBridge["platform"] (src/types/desktop.d.ts) — re-declared rather than imported
// since the ambient global has no exported type to pull from.
export type DesktopPlatform = "darwin" | "win32" | "linux"

// Strip height (spec: "~38px") — exported so AppShell can grow the canvas gap by exactly this much
// when the strip is present, instead of a second hardcoded number drifting out of sync.
export const SYSTEM_STRIP_HEIGHT_PX = 38

// Left inset reserved for macOS's native traffic lights (spec: "~72px") — no custom controls render
// under it, darwin only.
const DARWIN_TRAFFIC_LIGHT_INSET_PX = 72

export interface SystemStripLayout {
	// px reserved at the strip's left edge; 0 on platforms with no native traffic lights to clear.
	readonly leftInsetPx: number
	// win32/linux render minimize/maximize-toggle/hide/close top-right; darwin never does — the
	// traffic lights already cover minimize/maximize/close, and desktop `hide` has no darwin button
	// (Cmd+H is the native affordance).
	readonly showWindowControls: boolean
}

export function deriveSystemStripLayout(platform: DesktopPlatform): SystemStripLayout {
	if (platform === "darwin") {
		return { leftInsetPx: DARWIN_TRAFFIC_LIGHT_INSET_PX, showWindowControls: false }
	}

	return { leftInsetPx: 0, showWindowControls: true }
}

export type MaximizeIconState = "maximize" | "restore"

// The maximize-toggle button's icon follows DesktopBridge.onMaximizedChange — a plain boolean-to-enum
// map, but pulled out so the toggle behavior is pinned independent of the icon components used to
// render each state.
export function deriveMaximizeIconState(maximized: boolean): MaximizeIconState {
	return maximized ? "restore" : "maximize"
}
