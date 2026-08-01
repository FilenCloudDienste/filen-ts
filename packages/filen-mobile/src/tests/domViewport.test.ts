// @vitest-environment happy-dom

// Guards the in-page half of the WebView keyboard fix (#102).
//
// The page is sized from the LAYOUT viewport, which DomKeyboardHost keeps clear of the keyboard by
// shrinking the WebView. Sizing it from `visualViewport` instead was tried and reverted: with the
// host shrinking the view it can only subtract zero, while a transient reading during an overscroll
// latched the page smaller than the viewport.

import { describe, it, expect, vi } from "vitest"

import { createLayoutThemeSpec, CODE_MIRROR_DIMENSIONS, CODE_MIRROR_HEIGHT } from "@/components/textEditor/codeMirrorLayout"

function setViewportHeight(height: number): void {
	Object.defineProperty(window, "innerHeight", {
		value: height,
		configurable: true,
		writable: true
	})

	window.dispatchEvent(new Event("resize"))
}

async function freshModule(initialHeight = 800) {
	vi.resetModules()

	document.head.replaceChildren()

	Object.defineProperty(window, "innerHeight", {
		value: initialHeight,
		configurable: true,
		writable: true
	})

	return await import("@/lib/domViewport")
}

function nextFrame(): Promise<void> {
	return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

function resetCss(): string {
	return document.getElementById("filen-dom-viewport-reset")?.textContent ?? ""
}

describe("installDomViewportReset", () => {
	it("zeroes the body margin the DOM shell leaves at the UA default", async () => {
		// The shell ships no reset, so `body { margin: 8px }` pushed every viewport-sized component
		// 16px past the page in both axes — a second, page-level scroller around the component's own.
		const { installDomViewportReset } = await freshModule()

		installDomViewportReset()

		expect(resetCss()).toMatch(/html,\s*body\s*\{[^}]*margin:\s*0/)
	})

	it("stops the page itself from scrolling", async () => {
		// Whatever slack the page has becomes scrollable overflow the moment the keyboard appears —
		// which is how a two-line note could be scrolled entirely off screen.
		const { installDomViewportReset } = await freshModule()

		installDomViewportReset()

		expect(resetCss()).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden/)
	})

	it("sizes the page from the layout viewport and nothing else", async () => {
		// The layout viewport is what DomKeyboardHost controls. Deriving the height from any other
		// measurement is what let a scroll transient latch the page smaller than the viewport.
		const { installDomViewportReset, VIEWPORT_HEIGHT } = await freshModule()

		installDomViewportReset()

		expect(VIEWPORT_HEIGHT).toBe("100dvh")
		expect(resetCss()).toContain(`height: ${VIEWPORT_HEIGHT}`)
		expect(resetCss()).not.toContain("var(")
	})

	it("is idempotent — two components in one WebView inject one stylesheet", async () => {
		const { installDomViewportReset } = await freshModule()

		installDomViewportReset()
		installDomViewportReset()
		installDomViewportReset()

		expect(document.querySelectorAll("#filen-dom-viewport-reset")).toHaveLength(1)
	})
})

describe("onViewportChange", () => {
	it("notifies after a height change, once the new height is laid out", async () => {
		const { installDomViewportReset, onViewportChange } = await freshModule(800)

		installDomViewportReset()

		const listener = vi.fn()
		const unsubscribe = onViewportChange(listener)

		setViewportHeight(500)

		await nextFrame()

		expect(listener).toHaveBeenCalledTimes(1)

		unsubscribe()
	})

	it("stays silent when the height did not move", async () => {
		// The regression this exists to prevent: placing a caret while the keyboard is already up
		// resizes nothing, and a listener firing there dragged the editor back to the PREVIOUS caret.
		const { installDomViewportReset, onViewportChange } = await freshModule(800)

		installDomViewportReset()

		const listener = vi.fn()
		const unsubscribe = onViewportChange(listener)

		setViewportHeight(800)
		setViewportHeight(800)

		await nextFrame()

		expect(listener).not.toHaveBeenCalled()

		unsubscribe()
	})

	it("does not replay the height it was installed with", async () => {
		const { installDomViewportReset, onViewportChange } = await freshModule(800)

		installDomViewportReset()

		const listener = vi.fn()
		const unsubscribe = onViewportChange(listener)

		await nextFrame()

		expect(listener).not.toHaveBeenCalled()

		unsubscribe()
	})

	it("coalesces a burst into one notification", async () => {
		// `resize` fires repeatedly for the whole keyboard animation, and re-scrolling the caret is a
		// real transaction on the editor.
		const { installDomViewportReset, onViewportChange } = await freshModule(800)

		installDomViewportReset()

		const listener = vi.fn()
		const unsubscribe = onViewportChange(listener)

		setViewportHeight(700)
		setViewportHeight(600)
		setViewportHeight(500)

		await nextFrame()

		expect(listener).toHaveBeenCalledTimes(1)

		unsubscribe()
	})

	it("stops notifying once unsubscribed", async () => {
		const { installDomViewportReset, onViewportChange } = await freshModule(800)

		installDomViewportReset()

		const listener = vi.fn()
		const unsubscribe = onViewportChange(listener)

		unsubscribe()

		setViewportHeight(500)

		await nextFrame()

		expect(listener).not.toHaveBeenCalled()
	})
})

describe("createLayoutThemeSpec", () => {
	const font = { size: 14, family: "Inter", lineHeight: 1.5, weight: 400 }

	it("puts the host's padding on the scrolled content, never on the editor box", () => {
		// `.cm-editor` is a fixed-height box, so padding there is a strip the document can never move
		// through — and the drive preview's paddingTop exists precisely so content scrolls UNDER its
		// overlaid header. CodeMirror reads `.cm-content` padding back as `documentPadding` and offsets
		// the gutters by it, so line numbers stay aligned.
		const spec = createLayoutThemeSpec({
			type: "code",
			isTextFile: false,
			font,
			paddingTop: 96,
			paddingBottom: 34
		})

		expect(spec[".cm-content"]?.["paddingTop"]).toBe("96px")
		expect(spec[".cm-content"]?.["paddingBottom"]).toBe("34px")

		for (const [property, value] of Object.entries(spec["&"] ?? {})) {
			expect(`${property}: ${value}`).not.toMatch(/padding/i)
		}
	})

	it("gives prose horizontal breathing room and leaves code flush to its gutter", () => {
		const prose = createLayoutThemeSpec({ type: "text", isTextFile: true, font })
		const code = createLayoutThemeSpec({ type: "code", isTextFile: false, font })

		expect(prose[".cm-content"]?.["padding"]).toBe("16px")
		// Unset rather than "0px": CodeMirror's own `4px 0` is the intended default here, and
		// overriding it with zero would silently restyle every code file.
		expect(code[".cm-content"]?.["padding"]).toBeUndefined()
	})

	it("hides the gutter for prose and keeps it for code", () => {
		expect(createLayoutThemeSpec({ type: "text", isTextFile: true, font })[".cm-gutters"]?.["display"]).toBe("none !important")
		expect(createLayoutThemeSpec({ type: "code", isTextFile: false, font })[".cm-gutters"]?.["display"]).toBeUndefined()
	})

	it("keeps the host's font on every text surface", () => {
		// The spec was lifted out of the editor to make the padding assertion above possible; this is
		// the guard that the lift changed nothing visible.
		const spec = createLayoutThemeSpec({ type: "code", isTextFile: false, font })

		expect(spec["&"]?.["fontSize"]).toBe("14px !important")
		expect(spec[".cm-line"]?.["fontSize"]).toBe("14px !important")
		expect(spec[".cm-gutters"]?.["fontSize"]).toBe("14px !important")
		expect(spec["&"]?.["fontFamily"]).toBe("Inter !important")
	})

	it("sizes prose from the larger default when the host supplies no font", () => {
		expect(createLayoutThemeSpec({ type: "text", isTextFile: true })["&"]?.["fontSize"]).toBe("16px !important")
		expect(createLayoutThemeSpec({ type: "code", isTextFile: false })["&"]?.["fontSize"]).toBe("14px !important")
	})
})

describe("CODE_MIRROR_DIMENSIONS", () => {
	it("sizes the editor with a definite height and never a minimum", () => {
		// A minimum lets the editor grow past the viewport, which leaves `.cm-scroller`'s `height: 100%`
		// unresolved: the PAGE becomes the scroller rather than the editor.
		// `@uiw/react-codemirror` takes minHeight/maxHeight just as happily, so nothing but this stops
		// the box from going unbounded again.
		expect(CODE_MIRROR_DIMENSIONS.height).toBe(CODE_MIRROR_HEIGHT)
		expect(CODE_MIRROR_DIMENSIONS).not.toHaveProperty("minHeight")
		expect(CODE_MIRROR_DIMENSIONS).not.toHaveProperty("maxHeight")
	})

	it("sizes from the shared viewport height", async () => {
		const { VIEWPORT_HEIGHT } = await freshModule()

		expect(CODE_MIRROR_HEIGHT).toBe(VIEWPORT_HEIGHT)
	})
})
