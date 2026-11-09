import { describe, expect, it } from "vitest"
import { presentationWheelZoom, presentationZoom } from "@/features/presentation/lib/zoom"
import { presentationEditorKey } from "@/features/presentation/lib/keymap/editor"

// The editor's slide zoom: steps from the zoom shown, the limits, and the keys on Mac and elsewhere.

function key(change: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) {
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
		expect(presentationEditorKey(key({ key: "=", ctrlKey: true }), {}, false)).toBe("presentation.zoomIn")
		expect(presentationEditorKey(key({ key: "+", ctrlKey: true, shiftKey: true }), {}, false)).toBe("presentation.zoomIn")
		expect(presentationEditorKey(key({ key: "+", ctrlKey: true }), {}, false)).toBe("presentation.zoomIn")
		expect(presentationEditorKey(key({ key: "-", ctrlKey: true }), {}, false)).toBe("presentation.zoomOut")
		expect(presentationEditorKey(key({ key: "o", code: "KeyO", ctrlKey: true, altKey: true }), {}, false)).toBe("presentation.zoomFit")
		expect(presentationEditorKey(key({ key: "ø", code: "KeyO", metaKey: true, altKey: true }), {}, true)).toBe("presentation.zoomFit")
		expect(presentationEditorKey(key({ key: "=", metaKey: true }), {}, true)).toBe("presentation.zoomIn")
		// Without Alt the character decides, never the physical key (another layout's letter there).
		expect(presentationEditorKey(key({ key: "ø", code: "KeyO", ctrlKey: true }), {}, false)).toBeUndefined()
	})
})
