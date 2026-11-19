// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing, type TextEditController } from "@filen/office/react/presentation"
import { Schema } from "prosemirror-model"
import { EditorState, TextSelection } from "prosemirror-state"
import { PresentationTableRange, tableGroups } from "@/features/presentation/components/ribbon/table"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { previewPptxObjects } from "@/locales/en/previewPptx/objects"
import "@/lib/i18n"

// Cell ranges in a selected table: Shift+press on a cell selects from the first cell to it, dragging on extends it, a
// plain press clears it; from the keyboard Shift+arrow at the edge of an open cell's text selects cells, inside its text
// it is the text's; Merge and Split act on the range, and Split splits any one merged cell back, one spanning the
// whole table too.

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
function renderOf(areas: readonly number[], rtl = false): SlideRender {
	const layer = {
		shape: { slide: ref, id: 4 },
		role: "table",
		drawing: {},
		matrix: [1, 0, 0, 1, 0, 0],
		box: { id: 4, xfrm: FRAME },
		table: {
			columnEdges: [0, 100, 200, 300],
			rowEdges: [0, 100, 200],
			areas: Int32Array.from(areas),
			textBoxes: [],
			flags: rtl ? { rtl: true } : {}
		}
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

const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} } })

// A cell (A1 unless `col` says otherwise) open in the text editor, holding "Cell" with the caret at `caret` (a document
// position), its paragraph right to left when `rtl`.
function openCell(caret: number, { rtl = false, col = 0 }: { rtl?: boolean; col?: number } = {}): TextEditController {
	const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Cell")])])
	const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret) })

	return {
		shape: { slide: ref, id: 4, cell: { row: 0, col } },
		state,
		rtl,
		subscribe: () => () => undefined
	} as unknown as TextEditController
}

function mount(areas: readonly number[], open?: TextEditController, rtl = false) {
	const selection = createShapeSelection()
	const text = createTextEditing()
	const ops: DeckOp[] = []

	selection.show(ref)
	selection.set([4])

	if (open !== undefined) text.set(open)

	const editor: PresentationRibbonEditor = {
		info: INFO,
		render: renderOf(areas, rtl),
		selection,
		text,
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

	it("selects cells by Shift+arrow from the end of an open cell's text, and merges them", async () => {
		const { ops, slide } = mount(PLAIN, openCell(5))

		expect(button("Merge cells").hasAttribute("disabled")).toBe(true)

		const pressed = fireEvent.keyDown(slide, { key: "ArrowRight", shiftKey: true })

		expect(pressed).toBe(false)
		expect(screen.getByText("1 × 2 cells selected")).toBeDefined()

		act(() => {
			fireEvent.keyDown(slide, { key: "ArrowDown", shiftKey: true })
		})

		expect(screen.getByText("2 × 2 cells selected")).toBeDefined()

		act(() => {
			fireEvent.keyDown(slide, { key: "ArrowUp", shiftKey: true })
		})

		expect(screen.getByText("1 × 2 cells selected")).toBeDefined()

		await act(async () => {
			fireEvent.click(button("Merge cells"))
			await Promise.resolve()
		})

		expect(ops).toEqual([
			{ family: "table", kind: "merge", target: { slide: ref, id: 4 }, range: { row: 0, col: 0, rows: 1, cols: 2 } }
		])

		act(() => {
			fireEvent.keyDown(slide, { key: "Escape" })
		})

		expect(screen.queryByText("1 × 2 cells selected")).toBeNull()
	})

	it("leaves Shift+arrow inside an open cell's text to the text, and a plain arrow clears a range", () => {
		const { slide } = mount(PLAIN, openCell(3))

		expect(fireEvent.keyDown(slide, { key: "ArrowRight", shiftKey: true })).toBe(true)
		expect(screen.queryByText(/cells selected/)).toBeNull()

		act(() => {
			fireEvent.keyDown(slide, { key: "ArrowLeft", shiftKey: true })
		})

		expect(screen.queryByText(/cells selected/)).toBeNull()

		act(() => {
			fireEvent.pointerDown(slide, { clientX: 150, clientY: 50, shiftKey: true, pointerId: 1, button: 0 })
			fireEvent.pointerUp(slide, { clientX: 150, clientY: 50, pointerId: 1 })
		})

		expect(screen.getByText("1 × 2 cells selected")).toBeDefined()

		act(() => {
			fireEvent.keyDown(slide, { key: "ArrowRight" })
		})

		expect(screen.queryByText(/cells selected/)).toBeNull()
	})

	it("mirrors Left and Right at the edge of a right-to-left paragraph", () => {
		const { slide } = mount(PLAIN, openCell(5, { rtl: true, col: 1 }))

		// The caret is at the text's end: Shift+ArrowRight selects the last character there.
		expect(fireEvent.keyDown(slide, { key: "ArrowRight", shiftKey: true })).toBe(true)
		expect(screen.queryByText(/cells selected/)).toBeNull()

		let pressed = true

		act(() => {
			pressed = fireEvent.keyDown(slide, { key: "ArrowLeft", shiftKey: true })
		})

		expect(pressed).toBe(false)
		expect(screen.getByText("1 × 2 cells selected")).toBeDefined()
	})

	it("moves to the visually adjacent cell in a right-to-left table", async () => {
		const { ops, slide } = mount(PLAIN, openCell(5, { col: 1 }), true)

		act(() => {
			fireEvent.keyDown(slide, { key: "ArrowRight", shiftKey: true })
		})

		expect(screen.getByText("1 × 2 cells selected")).toBeDefined()

		await act(async () => {
			fireEvent.click(button("Merge cells"))
			await Promise.resolve()
		})

		expect(ops).toEqual([
			{ family: "table", kind: "merge", target: { slide: ref, id: 4 }, range: { row: 0, col: 0, rows: 1, cols: 2 } }
		])
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
