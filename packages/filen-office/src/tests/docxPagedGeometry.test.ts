import type { Node } from "prosemirror-model"
import { describe, expect, it, vi } from "vitest"
import { Region, SOURCE_INTS, SourceInt, type PageDisplayList } from "@filen/office/core/docx"
import { docxSchema } from "@filen/office/core/docx/edit"
import { MarkBoxes, PagedGeometry, type PageRect } from "@filen/office/core/docx/paged"
import { HitTester, LINE_FLOATS, LINE_INTS, LineFlag, LineInt } from "@filen/office/core/text"
import { buildDocx } from "./docxSynthetic"
import { readBytes } from "./layoutFixtures"
import { editedLayout, type EditedLayout } from "./pagedFixtures"

// Positions of the editing document and points on the laid-out pages map onto each other exactly.

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname

// The boxes rangesBoxes() gives for `ranges` on page `page`, as rects() gives them, the index of each box's range
// added to `owners`.
function boxesOf(
	geometry: PagedGeometry,
	ranges: readonly { readonly from: number; readonly to: number }[],
	longest: number,
	page: number,
	owners: number[] = []
): PageRect[] {
	const boxes = new MarkBoxes()
	const out: PageRect[] = []

	geometry.rangesBoxes(ranges, longest, page, boxes)

	for (let b = 0; b < boxes.count; b++) {
		const at = b * 4

		out.push({
			page,
			x: boxes.values[at + 2] ?? 0,
			y: boxes.values[at] ?? 0,
			width: boxes.values[at + 3] ?? 0,
			height: boxes.values[at + 1] ?? 0
		})
		owners.push(boxes.owners[b] ?? -1)
	}

	return out
}

function geometryOf(edited: EditedLayout): PagedGeometry {
	return new PagedGeometry(edited.story, edited.index, { page: index => edited.layout.pages[index] }, new HitTester(edited.layout.styles))
}

interface Probe {
	readonly page: number
	readonly line: number
	readonly x: number
	readonly y: number
}

// Points at the start, middle and end of every body line.
function probes(pages: readonly PageDisplayList[], story: number): Probe[] {
	const out: Probe[] = []

	for (const page of pages) {
		const text = page.text

		for (let line = 0; line < text.lineCount; line++) {
			const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1

			if (page.sourceInts[source * SOURCE_INTS + SourceInt.REGION] !== Region.BODY) continue
			if (page.sourceInts[source * SOURCE_INTS + SourceInt.STORY] !== story) continue

			const top = text.lineFloats[line * LINE_FLOATS] ?? 0
			const height = text.lineFloats[line * LINE_FLOATS + 1] ?? 0
			const x = text.lineFloats[line * LINE_FLOATS + 3] ?? 0
			const width = text.lineFloats[line * LINE_FLOATS + 4] ?? 0

			for (const at of [x + 0.5, x + width / 2, x + width - 0.5]) out.push({ page: page.index, line, x: at, y: top + height / 2 })
		}
	}

	return out
}

// Hit -> position -> drawn box -> hit again lands on the same position, on the same line.
function roundTrips(edited: EditedLayout): { total: number; errors: string[] } {
	const geometry = geometryOf(edited)
	const errors: string[] = []
	const list = probes(edited.layout.pages, edited.story.story.story.index)

	for (const probe of list) {
		const hit = geometry.hitTest(probe.page, probe.x, probe.y)

		if (hit === undefined || hit.atom) continue

		const box = geometry.locate(hit.pos, hit.affinity)

		if (box === undefined) {
			errors.push(`unlocated ${hit.pos} from page ${probe.page} line ${probe.line}`)

			continue
		}

		const again = geometry.hitTest(box.page, box.x, box.top + box.height / 2)

		if (box.page !== probe.page || box.line !== probe.line || again?.pos !== hit.pos)
			errors.push(`${probe.page}/${probe.line} x ${probe.x.toFixed(1)}: pos ${hit.pos} -> ${box.page}/${box.line} -> ${again?.pos}`)
	}

	return { total: list.length, errors }
}

// Every body line's text equals the editing document's text between the line's ends (generated text and
// atoms aside).
function lineTexts(edited: EditedLayout): string[] {
	const geometry = geometryOf(edited)
	const doc = edited.session.state.doc
	const errors: string[] = []

	for (const page of edited.layout.pages) {
		const text = page.text

		for (let line = 0; line < text.lineCount; line++) {
			const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1

			if (page.sourceInts[source * SOURCE_INTS + SourceInt.REGION] !== Region.BODY) continue

			const x = text.lineFloats[line * LINE_FLOATS + 3] ?? 0
			const width = text.lineFloats[line * LINE_FLOATS + 4] ?? 0
			const start = geometry.atLine(page, line, x - 1)
			const end = geometry.atLine(page, line, x + width + 1)

			if (start === undefined || end === undefined || start.atom) continue

			const laid = (page.sourceTexts[source] ?? "").slice(
				text.lineInts[line * LINE_INTS + LineInt.TEXT_START] ?? 0,
				text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0
			)
			let plain = true

			// Lines of plain text only: atoms show generated text (note marks, field results) or nothing (range
			// markers), deleted text is hidden in the final view.
			doc.nodesBetween(start.pos, end.pos, node => {
				if (node.isInline && (!node.isText || node.marks.some(mark => mark.type === docxSchema.marks.deletion))) plain = false

				return plain
			})

			const edited = doc.textBetween(start.pos, end.pos)
			const last = ((text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0) & LineFlag.LAST) !== 0

			if (plain && !last && laid.replace(/\s+$/, "") !== edited.replace(/\s+$/, ""))
				errors.push(`${page.index}/${line}: ${JSON.stringify(laid)} != ${JSON.stringify(edited)}`)
		}
	}

	return errors
}

function paragraphAt(doc: Node, index: number): { node: Node; pos: number } {
	let found: { node: Node; pos: number } | undefined
	let k = 0

	doc.descendants((node, pos) => {
		if (found !== undefined) return false

		if (node.type === docxSchema.nodes.paragraph && node.textContent.length > 20) {
			if (k++ === index) found = { node, pos }

			return false
		}

		return true
	})

	if (found === undefined) throw new Error("no paragraph")

	return found
}

const p = (text: string, pPr = ""): string =>
	`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

describe("paged geometry", () => {
	for (const name of ["01-plain.docx", "03-header-footer-footnotes.docx", "05-fields-toc.docx", "04-comments-tracked.docx"]) {
		it(`maps every line of ${name} both ways`, async () => {
			const edited = await editedLayout(readBytes(FIXTURES + name))
			const result = roundTrips(edited)

			expect(result.total).toBeGreaterThan(10)
			expect(result.errors.slice(0, 5)).toEqual([])
			expect(lineTexts(edited).slice(0, 5)).toEqual([])
		})
	}

	it("maps edited paragraphs through their overlays", async () => {
		const body =
			Array.from({ length: 30 }, (_, k) => p(`Paragraph ${k} ${"lorem ipsum dolor sit amet ".repeat(8)}`)).join("") +
			'<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>' +
			p("first cell with some words in it") +
			"</w:tc><w:tc>" +
			p("second cell") +
			"</w:tc></w:tr></w:tbl>" +
			p("after")
		const edited = await editedLayout(buildDocx({ body }))
		const target = paragraphAt(edited.session.state.doc, 5)

		await edited.edit(edited.session.state.tr.insertText("inserted text ", target.pos + 4))
		await edited.edit(edited.session.state.tr.split(target.pos + 30))

		const cell = paragraphAt(edited.session.state.doc, 31)

		await edited.edit(edited.session.state.tr.insertText("typed ", cell.pos + 1))

		const result = roundTrips(edited)

		expect(result.errors.slice(0, 5)).toEqual([])
		expect(lineTexts(edited).slice(0, 5)).toEqual([])

		// The caret after the inserted text is drawn right after it.
		const geometry = geometryOf(edited)
		const at = paragraphAt(edited.session.state.doc, 5).pos + 4 + "inserted text ".length
		const box = geometry.locate(at, 1)

		expect(box).toBeDefined()

		const hit = geometry.hitTest(box?.page ?? 0, box?.x ?? 0, (box?.top ?? 0) + 2)

		expect(hit?.pos).toBe(at)
	})

	it("keeps a line's end apart from the next line's start", async () => {
		const edited = await editedLayout(buildDocx({ body: p("word ".repeat(80)) }))
		const geometry = geometryOf(edited)
		const page = edited.layout.pages[0]

		if (page === undefined) throw new Error("no page")

		const end = geometry.atLine(page, 0, 10000)

		expect(end?.affinity).toBe(-1)

		const upstream = geometry.locate(end?.pos ?? 0, -1)
		const downstream = geometry.locate(end?.pos ?? 0, 1)

		expect(upstream?.line).toBe(0)
		expect(downstream?.line).toBe(1)
		expect(downstream?.x ?? 0).toBeLessThan(upstream?.x ?? 0)
	})

	it("moves by lines keeping the column and selects across lines and pages", async () => {
		const edited = await editedLayout(
			buildDocx({ body: Array.from({ length: 40 }, (_, k) => p(`Line ${k} ${"text ".repeat(60)}`)).join("") })
		)
		const geometry = geometryOf(edited)
		const start = geometry.hitTest(0, 300, 100)

		if (start === undefined) throw new Error("no hit")

		let pos = start.pos
		let affinity = start.affinity
		let page = 0
		let moves = 0

		while (page < 1 && moves < 200) {
			const next = geometry.verticalMove(pos, affinity, 300, 1)

			if (next === undefined) break

			const box = geometry.locate(next.pos, next.affinity)

			expect(Math.abs((box?.x ?? 0) - 300)).toBeLessThan(25)
			pos = next.pos
			affinity = next.affinity
			page = next.page
			moves++
		}

		expect(page).toBe(1)

		const rects0 = geometry.rects(start.pos, pos, 0)
		const rects1 = geometry.rects(start.pos, pos, 1)

		expect(rects0.length).toBeGreaterThan(10)
		expect(rects1.length).toBeGreaterThanOrEqual(1)

		const back = geometry.verticalMove(pos, affinity, 300, -1)

		expect(back?.page).toBe(0)
		expect(geometry.wordRange(start.pos + 1).to).toBeGreaterThan(geometry.wordRange(start.pos + 1).from)
	})

	it("draws many ranges in one pass as rects() draws each, again after an edit", async () => {
		const body =
			Array.from({ length: 30 }, (_, k) => p(`Paragraph ${k} ${"lorem ipsum dolor sit amet ".repeat(8)}`)).join("") +
			'<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>' +
			p("first cell with some words in it") +
			"</w:tc><w:tc>" +
			p("second cell") +
			"</w:tc></w:tr></w:tbl>" +
			p("after")
		const edited = await editedLayout(buildDocx({ body }))
		// Every word (as spelling marks are), plus ranges across lines and paragraphs, and an empty one.
		const rangesOf = (doc: Node): { from: number; to: number }[] => {
			const out: { from: number; to: number }[] = []

			doc.descendants((node, pos) => {
				if (!node.isText) return true

				for (const match of (node.text ?? "").matchAll(/\S+/g))
					out.push({ from: pos + match.index, to: pos + match.index + match[0].length })

				return false
			})
			out.push({ from: 40, to: 400 }, { from: 7, to: 7 })

			return out.sort((a, b) => a.from - b.from)
		}
		const compare = (geometry: PagedGeometry, ranges: readonly { from: number; to: number }[]): number => {
			const longest = Math.max(...ranges.map(range => range.to - range.from))
			let boxes = 0

			for (let page = 0; page < edited.layout.pages.length; page++) {
				const owners: number[] = []
				const many = boxesOf(geometry, ranges, longest, page, owners)

				boxes += many.length

				for (let k = 0; k < ranges.length; k++) {
					const range = ranges[k]

					if (range === undefined) continue

					expect(many.filter((_, index) => owners[index] === k)).toEqual(geometry.rects(range.from, range.to, page))
				}
			}

			return boxes
		}
		const geometry = geometryOf(edited)

		expect(compare(geometry, rangesOf(edited.session.state.doc))).toBeGreaterThan(200)
		// Remembered boxes come back the same.
		expect(compare(geometry, rangesOf(edited.session.state.doc))).toBeGreaterThan(200)

		await edited.edit(edited.session.state.tr.insertText("typed words ", paragraphAt(edited.session.state.doc, 2).pos + 3))

		expect(compare(geometryOf(edited), rangesOf(edited.session.state.doc))).toBeGreaterThan(200)
		// The same geometry after the edit: what it located and measured before the edit is not reused wrongly.
		expect(compare(geometry, rangesOf(edited.session.state.doc))).toBeGreaterThan(200)

		// And after undoing it: lines laid out as they were before measure as they did.
		await edited.edit(session => session.execute({ type: "history.undo" }))
		expect(compare(geometry, rangesOf(edited.session.state.doc))).toBeGreaterThan(200)
		await edited.edit(session => session.execute({ type: "history.redo" }))
		expect(compare(geometry, rangesOf(edited.session.state.doc))).toBeGreaterThan(200)

		// Another edit: only the lines it changed are measured again (lines laid out as before keep their boxes).
		await edited.edit(edited.session.state.tr.insertText("x", paragraphAt(edited.session.state.doc, 5).pos + 3))

		const ranges = rangesOf(edited.session.state.doc)
		const longest = Math.max(...ranges.map(range => range.to - range.from))
		const measured = vi.spyOn(geometry.tester, "xAtOffset")
		let boxes = 0

		for (let page = 0; page < edited.layout.pages.length; page++) boxes += boxesOf(geometry, ranges, longest, page).length

		expect(boxes).toBeGreaterThan(200)
		expect(measured.mock.calls.length).toBeLessThan(boxes / 4)
	})
})
