import { useSyncExternalStore } from "react"

// Whether a sign-out is wiping this device; it only ever turns on, since the reload that ends a sign-out
// takes the page with it.
let shown = false
const listeners = new Set<() => void>()

export function showSignOutOverlay(): void {
	if (shown) {
		return
	}

	shown = true

	for (const listener of listeners) {
		listener()
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

function isShown(): boolean {
	return shown
}

export function useSignOutOverlayShown(): boolean {
	return useSyncExternalStore(subscribe, isShown, () => false)
}
