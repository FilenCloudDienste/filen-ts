/**
 * Viewport plumbing for the WebView (DOM) components — #102.
 *
 * Two defects are fixed here, both inherited from expo's DOM-component shell:
 *
 * 1. The shell ships no CSS reset, so the UA's `body { margin: 8px }` pushes any viewport-sized box
 *    16px past the page in both axes: a page-level scroller wrapped around the component's own.
 *
 * 2. Neither platform shrinks the LAYOUT viewport for the on-screen keyboard, so `100dvh` keeps
 *    measuring the whole WebView and anything sized by it extends behind the keyboard — taking the
 *    caret with it, since both editors decide "is the cursor visible?" against that same box.
 *
 * Measured on both platforms with the keyboard up, WebView left at full height:
 *
 *     iOS      innerHeight 724 -> 724   visualViewport.height 724 -> 382
 *     Android  innerHeight 844 -> 844   visualViewport.height 844 -> 508
 *
 * `visualViewport` is therefore the one number both engines agree on, and it is the engine's own
 * measurement of how much of THIS WebView is obscured — it needs no help from native and cannot be
 * thrown off by where the host sits on screen.
 *
 * It is NOT sufficient alone, which is why DomKeyboardHost shrinks the WebView as well. Sizing the
 * page down still leaves the LAYOUT viewport at full height, and iOS reveals the caret by panning
 * the visual viewport inside that leftover room — dragging the whole page up and leaving a
 * keyboard-sized band of nothing above the keyboard (#102's iOS symptom, and the second scrollbar
 * along with it). Only shrinking the view removes the room to pan into.
 *
 * The two compose rather than double-count: once the view no longer reaches under the keyboard the
 * engine reports nothing obscured, so the measurement below returns the full height and subtracts
 * zero. If a host ever shrinks by the wrong amount, this trims whatever is still covered.
 */

const VIEWPORT_HEIGHT_PROPERTY = "--filen-viewport-height"

/**
 * The height of the area the keyboard does NOT cover, as a CSS value.
 *
 * Use this instead of `100dvh` for anything that should fill the WebView. The fallback covers the
 * first paint (before the first measurement) and any engine without `visualViewport`, where it
 * degrades to exactly the old behaviour rather than to nothing.
 */
export const VIEWPORT_HEIGHT = `var(${VIEWPORT_HEIGHT_PROPERTY}, 100dvh)`

let installed = false
let lastHeight = -1
let notifyFrame: number | null = null

const listeners = new Set<() => void>()

function measureViewportHeight(): number {
	const visualViewport = window.visualViewport

	if (!visualViewport) {
		return window.innerHeight
	}

	// Multiplied by `scale`, because the visual viewport shrinks for pinch-zoom exactly as it does for
	// a keyboard and this must only ever react to the second. At scale S the visible region is
	// `(layoutHeight - obscured) / S` CSS pixels, so scaling back recovers the obscured height alone
	// and leaves a zoomed document — the docx and pdf viewers both allow pinch-zoom — sized as if it
	// were not zoomed. At 1x this is a no-op.
	return visualViewport.height * visualViewport.scale
}

/** Writes the current height and reports whether it actually moved. */
function writeViewportHeight(): boolean {
	const height = measureViewportHeight()

	// Sub-pixel jitter is reported during the keyboard animation on both platforms; ignoring it keeps
	// a settled viewport from re-notifying (and re-scrolling the caret) forever.
	if (Math.abs(height - lastHeight) < 0.5) {
		return false
	}

	lastHeight = height

	document.documentElement.style.setProperty(VIEWPORT_HEIGHT_PROPERTY, `${height}px`)

	return true
}

function applyViewportHeight(): void {
	if (!writeViewportHeight()) {
		return
	}

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
		// height, not min-height: the page must not be able to extend behind the keyboard, or the
		// engine's own scroll container gains exactly one keyboard of overflow the moment the keyboard
		// appears — which is how a two-line note could be scrolled entirely off screen.
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
	writeViewportHeight()

	// `resize` alone is not enough: the layout viewport does not change when the keyboard opens, so on
	// both platforms that event never fires for it. `visualViewport` is the one that does — and it
	// also covers rotation, so the pair is belt and braces rather than two half-signals.
	window.addEventListener("resize", applyViewportHeight)
	window.visualViewport?.addEventListener("resize", applyViewportHeight)
	window.visualViewport?.addEventListener("scroll", applyViewportHeight)
}

/**
 * Runs `listener` after the usable viewport height has changed AND the new height has been laid out.
 *
 * Deliberately not a raw `resize` subscription: it fires only when the height actually moved, so
 * placing a caret while the keyboard is already up — which resizes nothing — cannot drag the editor
 * somewhere the user did not ask to go.
 */
export function onViewportChange(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}
