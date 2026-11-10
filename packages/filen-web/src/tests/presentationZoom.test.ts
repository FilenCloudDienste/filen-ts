import { describe, expect, it } from "vitest"
import { presentationWheelZoom, presentationZoom } from "@/features/presentation/lib/zoom"
import { presentationEditorKey } from "@/features/presentation/lib/keymap/editor"

// The editor's slide zoom: steps from the zoom shown, the limits, and the keys on Mac and elsewhere.

function key(change: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) {
	return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...change }
}

describe("presentation zoom", () => {
	it("steps from the fitting zoom shown, keeps it at a limit or unmeasured, and clamps a zoom", () => {
		expect(presentationZoom("fit", 0.5, "in")).toBe(0.67)
		expect(presentationZoom("fit", 0.5, "out")).toBe(0.33)
		expect(presentationZoom(1, 1, "fit")).toBe("fit")
		expect(presentationZoom(4, 4, "in")).toBe(4)
		expect(presentationZoom(0.25, 0.25, "out")).toBe(0.25)
		// A window narrower than the smallest step: zooming out never makes the slide larger.
		expect(presentationZoom("fit", 0.2, "out")).toBe("fit")
		expect(presentationZoom("fit", 0, "in")).toBe("fit")
		expect(presentationZoom("fit", 0.5, 9)).toBe(4)
		expect(presentationWheelZoom("fit", 0.5, -100)).toBeCloseTo(0.65)
		expect(presentationWheelZoom("fit", 0, -100)).toBe("fit")
	})

	it("takes Ctrl+Plus, Ctrl+Minus and Ctrl+Alt+O, and their Cmd forms on a Mac", () => {
		expect(presentationEditorKey(key({ key: "=", code: "Equal", ctrlKey: true }), {}, false)).toBe("presentation.zoomIn")
		expect(presentationEditorKey(key({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }), {}, false)).toBe(
			"presentation.zoomIn"
		)
		expect(presentationEditorKey(key({ key: "+", code: "NumpadAdd", ctrlKey: true }), {}, false)).toBe("presentation.zoomIn")
		expect(presentationEditorKey(key({ key: "-", code: "Minus", ctrlKey: true }), {}, false)).toBe("presentation.zoomOut")
		expect(presentationEditorKey(key({ key: "-", code: "NumpadSubtract", ctrlKey: true }), {}, false)).toBe("presentation.zoomOut")
		expect(presentationEditorKey(key({ key: "o", code: "KeyO", ctrlKey: true, altKey: true }), {}, false)).toBe("presentation.zoomFit")
		expect(presentationEditorKey(key({ key: "ø", code: "KeyO", metaKey: true, altKey: true }), {}, true)).toBe("presentation.zoomFit")
		expect(presentationEditorKey(key({ key: "=", code: "Equal", metaKey: true }), {}, true)).toBe("presentation.zoomIn")
		// Keys are physical: without Alt, Ctrl on the O key is no zoom whatever it types.
		expect(presentationEditorKey(key({ key: "ø", code: "KeyO", ctrlKey: true }), {}, false)).toBeUndefined()
	})

	it("zooms on the browser's own zoom keys wherever the layout puts them", () => {
		// A German keyboard's "+" and "-" keys.
		expect(presentationEditorKey(key({ key: "+", code: "BracketRight", ctrlKey: true }), {}, false)).toBe("presentation.zoomIn")
		expect(presentationEditorKey(key({ key: "-", code: "Slash", ctrlKey: true }), {}, false)).toBe("presentation.zoomOut")
		// A rebound key keeps its action; the fallback never takes a key an action holds.
		expect(
			presentationEditorKey(key({ key: "-", code: "Slash", ctrlKey: true }), { "presentation.newSlide": "mod+slash" }, false)
		).toBe("presentation.newSlide")
	})

	it("follows a key recorded on punctuation", () => {
		const overrides = { "presentation.zoomFit": "mod+bracketright" }

		expect(presentationEditorKey(key({ key: "]", code: "BracketRight", ctrlKey: true }), overrides, false)).toBe("presentation.zoomFit")
		expect(presentationEditorKey(key({ key: " ", code: "Space", ctrlKey: true }), { "presentation.zoomFit": "mod+space" }, false)).toBe(
			"presentation.zoomFit"
		)
	})
})
