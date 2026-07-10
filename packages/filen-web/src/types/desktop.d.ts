// Electron desktop bridge — no electron package exists yet (see the app-shell spec's "Electron
// plumbing" section); this is the typed contract a future preload script implements. `window.desktop`
// absent means a plain browser: every consumer (systemStrip.tsx, appShell.tsx) feature-detects it and
// renders nothing extra, so this file has zero runtime footprint outside Electron. No top-level
// import/export, so this augments the global scope directly (mirrors file-system-access.d.ts).

interface DesktopBridge {
	readonly platform: "darwin" | "win32" | "linux"
	minimize(): void
	toggleMaximize(): void
	hide(): void
	close(): void
	// Returns an unsubscribe function (mirrors every other subscribe-style API in this codebase, e.g.
	// zustand's own `subscribe`) — callers dispose it from a `useEffect` cleanup.
	onMaximizedChange(cb: (maximized: boolean) => void): () => void
}

interface Window {
	readonly desktop?: DesktopBridge
}
