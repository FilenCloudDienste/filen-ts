/**
 * Viewport plumbing for the WebView (DOM) components — #102.
 *
 * Expo's DOM-component shell ships no CSS reset, so the UA's `body { margin: 8px }` pushes any
 * viewport-sized box 16px past the page in both axes: a page-level scroller wrapped around the
 * component's own, and — once the keyboard is up — the slack that let a two-line note be scrolled
 * entirely off screen.
 *
 * Keeping the page clear of the keyboard is DomKeyboardHost's job, not this module's. It shrinks the
 * WebView, which shrinks the LAYOUT viewport, so `100dvh` here already measures the area the keyboard
 * does not cover: with the keyboard open, `innerHeight` and `visualViewport.height` agree exactly
 * (iOS 382/382, Android 508/508).
 *
 * Sizing the page from `visualViewport` INSTEAD was tried and reverted. Once the host shrinks the
 * view that measurement can only ever subtract zero, so it bought nothing — while a transient reading
 * during an overscroll at the end of a long document latched the page smaller than the viewport, and
 * left the document ending in mid-air well above the keyboard with the second scrollbar back.
 * Deriving the page height from anything but the layout viewport is the whole failure mode, and the
 * layout viewport is what native already controls.
 */

/** The height of the WebView's viewport, which DomKeyboardHost keeps clear of the keyboard. */
export const VIEWPORT_HEIGHT = "100dvh"

let installed = false
let lastHeight = -1
let notifyFrame: number | null = null

const listeners = new Set<() => void>()

function notifyIfHeightChanged(): void {
	const height = window.innerHeight

	if (height === lastHeight) {
		return
	}

	lastHeight = height

	// Deferred one frame so listeners measure AFTER the new height has been laid out — a caret
	// re-scroll computed against the old box would scroll to the wrong place. Coalesced, because
	// `resize` fires repeatedly while the keyboard animates.
	if (notifyFrame !== null) {
		return
	}

	notifyFrame = requestAnimationFrame(() => {
		notifyFrame = null

		for (const listener of listeners) {
			listener()
		}
	})
}

/**
 * Idempotent — every DOM component calls this at module scope, and one WebView may load more than
 * one of them (the markdown editor and its preview share a bundle).
 */
export function installDomViewportReset(): void {
	if (installed) {
		return
	}

	installed = true

	const style = document.createElement("style")

	style.id = "filen-dom-viewport-reset"
	style.textContent = [
		// height, not min-height: the page must not be able to extend past the viewport, or the engine's
		// own scroll container gains overflow with nothing in it.
		"html, body {",
		"\tmargin: 0;",
		"\tpadding: 0;",
		`\theight: ${VIEWPORT_HEIGHT};`,
		"\toverflow: hidden;",
		"\toverscroll-behavior: none;",
		"}",
		// The shell declares `#root { display: flex; flex: 1 }`, which resolves to nothing under a body
		// that is not itself a sized flex container.
		"#root {",
		"\theight: 100%;",
		"}"
	].join("\n")

	document.head.appendChild(style)

	// Seeded without notifying: nothing has subscribed yet, and a listener that subscribes on the same
	// tick must not be handed a change that predates it.
	lastHeight = window.innerHeight

	// The host shrinking the WebView is a LAYOUT viewport change, which is exactly what `resize`
	// reports — measured going 724 -> 382 on iOS and 844 -> 508 on Android as the keyboard opens.
	window.addEventListener("resize", notifyIfHeightChanged)
}

/**
 * Runs `listener` after the usable viewport height has changed AND the new height has been laid out.
 *
 * Fires only when the height actually moved, so placing a caret while the keyboard is already up —
 * which resizes nothing — cannot drag the editor somewhere the user did not ask to go.
 */
export function onViewportChange(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}
