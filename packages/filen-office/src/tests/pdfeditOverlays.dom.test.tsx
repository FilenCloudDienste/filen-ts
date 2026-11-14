// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PdfPlacementIndicator, PdfSelectionFrame, PdfTextBoxEditor, PdfToolDraftOverlay } from "../react/pdfedit/tools/index"

// The tool overlays: placed by percentages of the page box, handles only when resizable, the placement said in a
// live region, and the text box editor's input and finish.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

let host: HTMLDivElement
let root: Root

beforeEach(() => {
	host = document.createElement("div")
	document.body.append(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => {
		root.unmount()
	})
	host.remove()
})

// A polyline's points as its point list holds them.
function pointsOf(line: SVGPolylineElement | null): number[][] {
	const list = line?.points

	if (list === undefined) return []

	return Array.from({ length: list.numberOfItems }, (_, index) => {
		const point = list.getItem(index)

		return [point.x, point.y]
	})
}

describe("tool overlays", () => {
	it("appends each new ink point instead of rebuilding the stroke (linear in its length)", () => {
		const points = new Float64Array(1024)
		const appended = vi.spyOn(SVGPointList.prototype, "appendItem")
		const draw = (length: number): void => {
			act(() => {
				root.render(
					<PdfToolDraftOverlay
						draft={{ kind: "ink", stroke: { page: 0, points, length } }}
						box={[0, 0, 100, 200]}
					/>
				)
			})
		}

		for (let index = 0; index < 400; index += 2) {
			points[index] = index
			points[index + 1] = index / 2
			draw(index + 2)
		}

		// 200 points drawn one by one: one append each, never the whole stroke again.
		expect(appended).toHaveBeenCalledTimes(200)
		expect(pointsOf(host.querySelector("polyline")).at(-1)).toEqual([398, 199])

		// A new stroke (another start) starts the list anew.
		points[0] = 50
		draw(2)
		expect(pointsOf(host.querySelector("polyline"))).toEqual([[50, 0]])

		appended.mockRestore()
	})

	it("draws drafts in page space", () => {
		act(() => {
			root.render(
				<>
					<PdfToolDraftOverlay
						draft={{ kind: "ellipse", rect: [10, 20, 50, 60] }}
						box={[0, 0, 100, 200]}
					/>
					<PdfToolDraftOverlay
						draft={{
							kind: "ink",
							stroke: { page: 0, points: new Float64Array([1, 2, 3, 4, 0, 0]), length: 4 },
							color: [1, 0, 0],
							width: 3
						}}
						box={[0, 0, 100, 200]}
					/>
					<PdfToolDraftOverlay
						draft={{ kind: "quads", quads: [[0, 0, 10, 0, 0, 5, 10, 5]] }}
						box={[0, 0, 100, 200]}
					/>
				</>
			)
		})

		const svgs = host.querySelectorAll("svg")

		expect(svgs[0]?.getAttribute("viewBox")).toBe("0 0 100 200")
		expect(host.querySelector("ellipse")?.getAttribute("rx")).toBe("20")
		expect(pointsOf(host.querySelector("polyline"))).toEqual([
			[1, 2],
			[3, 4]
		])
		expect(host.querySelector("polyline")?.getAttribute("style")).toContain("stroke-width: 3")
		expect(host.querySelector("polygon")?.getAttribute("points")).toBe("0,0 10,0 10,5 0,5")
	})

	it("frames a selection with handles only when resizable", () => {
		act(() => {
			root.render(
				<PdfSelectionFrame
					rect={[10, 20, 60, 70]}
					box={[0, 0, 100, 200]}
					handles
				/>
			)
		})

		const frame = host.querySelector<HTMLElement>(".fo-pdf-tool-selection")

		expect(frame?.style.left).toBe("10%")
		expect(frame?.style.top).toBe("10%")
		expect(frame?.style.width).toBe("50%")
		expect(frame?.style.height).toBe("25%")
		expect(host.querySelectorAll(".fo-pdf-tool-handle")).toHaveLength(8)

		act(() => {
			root.render(
				<PdfSelectionFrame
					rect={[10, 20, 60, 70]}
					box={[0, 0, 100, 200]}
					handles={false}
				/>
			)
		})

		expect(host.querySelectorAll(".fo-pdf-tool-handle")).toHaveLength(0)
	})

	it("draws a keyboard placement, leaving its announcement to the host's one live region", () => {
		act(() => {
			root.render(
				<PdfPlacementIndicator
					rect={[0, 0, 50, 50]}
					box={[0, 0, 100, 100]}
				/>
			)
		})

		expect(host.querySelector(".fo-pdf-tool-placement")?.getAttribute("style")).toContain("width: 50%")
		expect(host.querySelector('[role="status"], [aria-live]')).toBeNull()
	})

	it("edits a text box and finishes on Mod+Enter or blur", () => {
		const onInput = vi.fn()
		const onDone = vi.fn()

		act(() => {
			root.render(
				<PdfTextBoxEditor
					rect={[0, 0, 50, 20]}
					box={[0, 0, 100, 100]}
					text="Hi"
					size={12}
					scale={2}
					color={[1, 0, 0]}
					align="center"
					label="Text box"
					onInput={onInput}
					onDone={onDone}
				/>
			)
		})

		const editor = host.querySelector("textarea")

		if (editor === null) throw new Error("no editor")

		expect(editor.getAttribute("aria-label")).toBe("Text box")
		expect(editor.style.fontSize).toBe("24px")
		expect(editor.style.textAlign).toBe("center")

		act(() => {
			editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))
		})
		expect(onDone).toHaveBeenCalledTimes(1)

		act(() => {
			editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
		})
		expect(onDone).toHaveBeenCalledTimes(1)
	})
})
