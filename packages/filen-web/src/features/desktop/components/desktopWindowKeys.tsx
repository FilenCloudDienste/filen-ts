import { useEffect } from "react"
import { useRouter } from "@tanstack/react-router"
import type { Options } from "react-hotkeys-hook"
import type { DesktopZoomStep } from "@filen/shared/desktop"
import { APP_ACTIONS } from "@/features/shell/lib/keymap"
import { desktopBridge } from "@/lib/desktop"
import { ALL_ACTIONS } from "@/lib/keymap/actions"
import { browserZoomKey, matchesOverride, userBinding } from "@/lib/keymap/browserZoom"
import { isAnyOverlayOpen } from "@/lib/keymap/dialogGuard"
import type { ActionDef } from "@/lib/keymap/registry"
import { useBindings } from "@/lib/keymap/registry"
import { IN_EDITORS_AND_FIELDS, OUTSIDE_OVERLAYS, shouldIgnoreEvent, useAction } from "@/lib/keymap/useAction"

const bridge = desktopBridge()
// A Mac's menu bar has zoom, full screen and quit (menu roles); Windows and Linux have no menu, so the page has them.
const MENU_BAR = bridge?.platform === "darwin"

// The window's keys work wherever focus is, in a field or an editor too, as a browser's do.
const WINDOW_KEYS: Options = { ...IN_EDITORS_AND_FIELDS, preventDefault: true }

function shellAction(id: string): ActionDef {
	const def = APP_ACTIONS.find(action => action.id === id)

	if (def === undefined) {
		throw new Error(`desktopWindowKeys: unknown action "${id}"`)
	}

	return def
}

const ZOOM_ACTIONS: Readonly<Record<DesktopZoomStep, ActionDef>> = {
	in: shellAction("desktop.zoomIn"),
	out: shellAction("desktop.zoomOut"),
	reset: shellAction("desktop.zoomReset")
}

// A zoom key a document viewer took (the PDF viewer and the presentation editor zoom themselves) is cancelled by then.
function zoomKeyIgnored(event: Parameters<typeof shouldIgnoreEvent>[0] & Pick<KeyboardEvent, "defaultPrevented">): boolean {
	return event.defaultPrevented || shouldIgnoreEvent(event)
}

// Desktop.close: the open dialog or menu closes as on Escape (a file preview, asking first about unsaved changes),
// the window when none is open.
function closeTopLayer(): void {
	if (!isAnyOverlayOpen()) {
		bridge?.window.close()

		return
	}

	const target = document.activeElement ?? document.body

	target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))
}

function zoom(step: DesktopZoomStep): void {
	bridge?.window.zoom(step)
}

function useZoomAction(step: DesktopZoomStep, userBound: boolean): void {
	useAction(
		ZOOM_ACTIONS[step].id,
		() => {
			zoom(step)
		},
		{ ...WINDOW_KEYS, enabled: userBound, ignoreEventWhen: zoomKeyIgnored },
		[userBound]
	)
}

// While a zoom action keeps its default it takes the zoom CHARACTERS, as a browser does ("+" is a German keyboard's
// BracketRight): a user who rebinds it gets exactly the keys they chose instead (useZoomAction), one who turns it off
// none, and a zoom key the user bound to another action is that action's.
function useZoomCharacters(combos: Readonly<Record<string, string>>): void {
	useEffect(() => {
		if (MENU_BAR) {
			return
		}

		const onKeyDown = (event: KeyboardEvent) => {
			const step = browserZoomKey(event, false)

			if (step === undefined || zoomKeyIgnored(event)) {
				return
			}

			const def = ZOOM_ACTIONS[step]

			if (combos[def.id] === "" || userBinding(combos, def) !== undefined) {
				return
			}

			if (ALL_ACTIONS.some(other => matchesOverride(event, userBinding(combos, other), false))) {
				return
			}

			event.preventDefault()
			zoom(step)
		}

		document.addEventListener("keydown", onKeyDown)

		return () => {
			document.removeEventListener("keydown", onKeyDown)
		}
	}, [combos])
}

// The desktop app's window keys, which a browser has of its own: back and forward, close, lock, and off a Mac zoom,
// full screen and quit. Mounted at the root with the desktop bridge, so the sign-in pages and the lock screen have
// them too. Renders nothing.
export function DesktopWindowKeys(): null {
	const router = useRouter()
	const combos = useBindings()

	useAction("app.lock", () => bridge?.lock.lock(), WINDOW_KEYS)
	useAction("desktop.close", closeTopLayer, WINDOW_KEYS)
	useAction(
		"desktop.back",
		() => {
			if (router.history.canGoBack()) {
				router.history.back()
			}
		},
		OUTSIDE_OVERLAYS,
		[router]
	)
	useAction(
		"desktop.forward",
		() => {
			router.history.forward()
		},
		OUTSIDE_OVERLAYS,
		[router]
	)
	useAction("desktop.fullScreen", () => bridge?.window.toggleFullScreen(), WINDOW_KEYS)
	useAction("desktop.quit", () => bridge?.app.quit(), WINDOW_KEYS)
	useZoomAction("in", userBinding(combos, ZOOM_ACTIONS.in) !== undefined)
	useZoomAction("out", userBinding(combos, ZOOM_ACTIONS.out) !== undefined)
	useZoomAction("reset", userBinding(combos, ZOOM_ACTIONS.reset) !== undefined)
	useZoomCharacters(combos)

	return null
}
