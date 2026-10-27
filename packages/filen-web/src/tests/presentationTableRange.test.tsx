// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import { PresentationTableRange, tableGroups } from "@/features/presentation/components/ribbon/table"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { previewPptxObjects } from "@/locales/en/previewPptx/objects"
import "@/lib/i18n"

// Cell ranges in a selected table: Shift+press on a cell selects from the first cell to it, dragging on extends it, a
// plain press clears it; Merge and Split act on the range, and Split splits any one merged cell back, one spanning
// the whole table too.

i18n.addResourceBundle("en", "preview", previewPptxObjects, true, false)

const EMU = 9525
const ref = slideRef(256)
const FRAME: Xfrm = { x: 0, y: 0, cx: 300 * EMU, cy: 200 * EMU, rot: 0, flipH: false, flipV: false }
const INFO = {
	format: "pptx",
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	editable: true
} as unknown as OpenInfo

// A 2 × 3 table of 100 × 100 px cells at the slide's corner; `areas` row, col, rows, cols per origin cell.
function renderOf(areas: readonly number[]): SlideRender {
	const layer = {
		shape: { slide: ref, id: 4 },
		role: "table",
		drawing: {},
		matrix: [1, 0, 0, 1, 0, 0],
		box: { id: 4, xfrm: FRAME },
		table: { columnEdges: [0, 100, 200, 300], rowEdges: [0, 100, 200], areas: Int32Array.from(areas), textBoxes: [], flags: {} }
	} as unknown as SlideLayer

	return {
		ref,
		index: 0,
		revision: 1,
		hidden: false,
		background: {},
		layers: [layer],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

const PLAIN = [0, 0, 1, 1, 0, 1, 1, 1, 0, 2, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1]

function mount(areas: readonly number[]) {
	const selection = createShapeSelection()
	const ops: DeckOp[] = []

	selection.show(ref)
	selection.set([4])

	const editor: PresentationRibbonEditor = {
		info: INFO,
		render: renderOf(areas),
		selection,
		session: {} as never,
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: 2, dirty: true })
		}
	}
	const groups = tableGroups({ editor, editable: true, t: i18n.getFixedT("en", "preview") } as never)
	const merge = groups.find(group => group.id === "merge")?.content
	const view = render(
		<>
			<div data-testid="slide">
				<PresentationTableRange
					editor={editor}
					scale={1}
				/>
			</div>
			{merge}
		</>
	)

	return { ops, view, slide: screen.getByTestId("slide") }
}

const button = (name: string) => screen.getByRole("button", { name })

afterEach(() => {
	cleanup()
})

describe("presentation table cell ranges", () => {
	it("selects a range by Shift+press and drag, merges it, and a plain press clears it", async () => {
		const { ops, slide } = mount(PLAIN)

		act(() => {
			fireEvent.pointerDown(slide, { clientX: 50, clientY: 50, shiftKey: true, pointerId: 1, button: 0 })
			fireEvent.pointerMove(slide, { clientX: 150, clientY: 150, pointerId: 1 })
			fireEvent.pointerUp(slide, { clientX: 150, clientY: 150, pointerId: 1 })
		})

		expect(screen.getByText("2 × 2 cells selected")).toBeDefined()
		expect(button("Split cells").hasAttribute("disabled")).toBe(true)

		await act(async () => {
			fireEvent.click(button("Merge cells"))
			await Promise.resolve()
		})

		expect(ops).toEqual([
			{ family: "table", kind: "merge", target: { slide: ref, id: 4 }, range: { row: 0, col: 0, rows: 2, cols: 2 } }
		])

		act(() => {
			fireEvent.pointerDown(slide, { clientX: 250, clientY: 50, pointerId: 2, button: 0 })
		})

		expect(screen.queryByText("2 × 2 cells selected")).toBeNull()
	})

	it("splits a merged cell spanning the whole table", async () => {
		const { ops } = mount([0, 0, 2, 3])

		expect(button("Split cells").hasAttribute("disabled")).toBe(false)

		await act(async () => {
			fireEvent.click(button("Split cells"))
			await Promise.resolve()
		})

		expect(ops).toEqual([{ family: "table", kind: "split", target: { slide: ref, id: 4 }, row: 0, col: 0 }])
	})
})
