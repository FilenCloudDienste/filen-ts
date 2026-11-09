import type { Node } from "prosemirror-model"
import { describe, expect, it } from "vitest"
import { TURN_FLOATS } from "@filen/office/core/docx"
import { PagedGeometry } from "@filen/office/core/docx/paged"
import { HitTester } from "@filen/office/core/text"
import { buildDocx } from "./docxSynthetic"
import { editedLayout, type EditedLayout } from "./pagedFixtures"

// Caret, selection and pointer geometry in sideways table cells (w:textDirection): boxes are where the turned text
// is drawn on the page, points there find their positions, and moving between lines goes across the text.

const SECTION =
	'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
const MARGINS =
	'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>'
const TEXT = "alpha bravo charlie delta echo foxtrot golf hotel"

function p(text: string): string {
	return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

// A row of exact height (80 px) whose first cell's text runs `direction` and wraps over lines.
async function turned(direction: string): Promise<EditedLayout> {
	return editedLayout(
		buildDocx({
			body:
				`<w:tbl><w:tblPr>${MARGINS}</w:tblPr><w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>` +
				`<w:tr><w:trPr><w:trHeight w:val="1200" w:hRule="exact"/></w:trPr><w:tc><w:tcPr><w:textDirection w:val="${direction}"/></w:tcPr>${p(TEXT)}</w:tc>` +
				`<w:tc>${p("beside")}</w:tc></w:tr></w:tbl>${p("after")}${SECTION}`
		})
	)
}

function geometryOf(edited: EditedLayout): PagedGeometry {
	return new PagedGeometry(edited.story, edited.index, { page: index => edited.layout.pages[index] }, new HitTester(edited.layout.styles))
}

// The position of `text`'s first character in the document.
function find(doc: Node, text: string): number {
	let found = -1

	doc.descendants((node, pos) => {
		if (found >= 0) return false

		const at = node.isText ? (node.text ?? "").indexOf(text) : -1

		if (at >= 0) found = pos + at

		return found < 0
	})

	return found
}

function box(edited: EditedLayout): { x: number; y: number; width: number; height: number } {
	const page = edited.layout.pages[0]

	return {
		x: page?.turnFloats[0] ?? 0,
		y: page?.turnFloats[1] ?? 0,
		width: page?.turnFloats[2] ?? 0,
		height: page?.turnFloats[TURN_FLOATS - 1] ?? 0
	}
}

describe("sideways cells: geometry", () => {
	for (const direction of ["btLr", "tbRl"]) {
		it(`draws the caret across ${direction} text, inside the cell`, async () => {
			const edited = await turned(direction)
			const geometry = geometryOf(edited)
			const cell = box(edited)
			const caret = geometry.locate(find(edited.session.state.doc, "charlie"), 1)

			expect(caret?.turn).toBe(direction === "btLr" ? 270 : 90)
			expect(caret?.height).toBe(0)
			expect(caret?.width ?? 0).toBeGreaterThan(5)
			expect(caret?.x ?? 0).toBeGreaterThanOrEqual(cell.x - 0.5)
			expect((caret?.x ?? 0) + (caret?.width ?? 0)).toBeLessThanOrEqual(cell.x + cell.width + 0.5)
			expect(caret?.top ?? 0).toBeGreaterThanOrEqual(cell.y - 0.5)
			expect(caret?.top ?? 0).toBeLessThanOrEqual(cell.y + cell.height + 0.5)
		})

		it(`finds positions under points of ${direction} text and back`, async () => {
			const edited = await turned(direction)
			const geometry = geometryOf(edited)
			const doc = edited.session.state.doc
			const start = find(doc, "alpha")

			for (const word of ["alpha", "bravo", "delta", "golf"]) {
				const pos = find(doc, word) + 2
				const caret = geometry.locate(pos, 1)
				const hit = geometry.hitTest(0, (caret?.x ?? 0) + (caret?.width ?? 0) / 2, caret?.top ?? 0)

				expect(hit?.pos).toBe(pos)
				expect(pos).toBeGreaterThan(start)
			}
		})

		it(`covers a selection in ${direction} text with boxes standing in the cell`, async () => {
			const edited = await turned(direction)
			const geometry = geometryOf(edited)
			const doc = edited.session.state.doc
			const cell = box(edited)
			const rects = geometry.rects(find(doc, "bravo"), find(doc, "bravo") + 5, 0)

			expect(rects).toHaveLength(1)
			expect(rects[0]?.height ?? 0).toBeGreaterThan(rects[0]?.width ?? 0)
			expect(rects[0]?.x ?? 0).toBeGreaterThanOrEqual(cell.x - 0.5)
			expect((rects[0]?.y ?? 0) + (rects[0]?.height ?? 0)).toBeLessThanOrEqual(cell.y + cell.height + 0.5)
		})
	}

	it("moves between the lines of sideways text across it", async () => {
		const edited = await turned("btLr")
		const geometry = geometryOf(edited)
		const doc = edited.session.state.doc
		const first = find(doc, "alpha")
		const caret = geometry.locate(first, 1)
		const next = geometry.verticalMove(first, 1, caret?.along ?? 0, 1)
		const moved = next === undefined ? undefined : geometry.locate(next.pos, next.affinity)

		// The next line of bottom to top text lies right of the first, its start where the first's is.
		expect(moved?.turn).toBe(270)
		expect(moved?.x ?? 0).toBeGreaterThan(caret?.x ?? 0)
		expect(moved?.top ?? 0).toBeCloseTo(caret?.top ?? 0, 0)
		expect(next?.pos ?? 0).toBeGreaterThan(first)
	})

	it("enters sideways text from the line above it at the side it comes in from", async () => {
		const edited = await editedLayout(
			buildDocx({
				body:
					`${p("above the table")}<w:tbl><w:tblPr>${MARGINS}</w:tblPr><w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>` +
					`<w:tr><w:tc><w:tcPr><w:textDirection w:val="btLr"/></w:tcPr>${p("label")}</w:tc><w:tc>${p("beside")}</w:tc></w:tr></w:tbl>${SECTION}`
			})
		)
		const geometry = geometryOf(edited)
		const doc = edited.session.state.doc
		const above = find(doc, "above")
		const hit = geometry.verticalMove(above, 1, 100, 1)

		// Read bottom to top, the text's end is at the cell's top: where the caret comes in from above.
		expect(hit?.pos).toBe(find(doc, "label") + "label".length)
	})
})
