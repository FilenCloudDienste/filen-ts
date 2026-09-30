import { useSyncExternalStore } from "react"

// Element fullscreen with the WebKit-prefixed fallback Safari still needs on some versions. A player
// fullscreens its own container, not the <video>, so its controls come along.

interface WebKitDocument {
	webkitFullscreenElement?: Element | null
	webkitFullscreenEnabled?: boolean
	webkitExitFullscreen?: () => void
}

interface WebKitElement {
	webkitRequestFullscreen?: () => void
}

const FULLSCREEN_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const

function webkitDocument(): WebKitDocument {
	return document as Document & WebKitDocument
}

function fullscreenElement(): Element | null {
	return document.fullscreenElement ?? webkitDocument().webkitFullscreenElement ?? null
}

export function fullscreenSupported(): boolean {
	return typeof document !== "undefined" && (document.fullscreenEnabled || webkitDocument().webkitFullscreenEnabled === true)
}

export async function toggleFullscreen(element: HTMLElement): Promise<void> {
	if (fullscreenElement() === element) {
		if (typeof document.exitFullscreen === "function") {
			await document.exitFullscreen()
		} else {
			webkitDocument().webkitExitFullscreen?.()
		}

		return
	}

	if (typeof element.requestFullscreen === "function") {
		await element.requestFullscreen()
	} else {
		;(element as HTMLElement & WebKitElement).webkitRequestFullscreen?.()
	}
}

function subscribe(notify: () => void): () => void {
	for (const event of FULLSCREEN_EVENTS) {
		document.addEventListener(event, notify)
	}

	return () => {
		for (const event of FULLSCREEN_EVENTS) {
			document.removeEventListener(event, notify)
		}
	}
}

export function useIsFullscreen(element: Element | null): boolean {
	return useSyncExternalStore(
		subscribe,
		() => element !== null && fullscreenElement() === element,
		() => false
	)
}
