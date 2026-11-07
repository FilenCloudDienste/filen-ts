import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { Fragment, Slice, type Node } from "prosemirror-model"
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { canJoin, canSplit } from "prosemirror-transform"
import { describe, expect, it } from "vitest"
import { DocxEditorSession, NO_SOURCE, docxSchema, freshSlice, normalizeListAttrs } from "@filen/office/core/docx/edit"
import { freshSliceKeeping, markInternal } from "../core/docx/edit/invariants/index"
import { joinBackward, joinForward } from "../core/docx/paged/keys"
import { originOf } from "../core/docx/edit/origin"
import { sourceCopies } from "../core/docx/edit/session"
import { unzipSync, zipSync } from "fflate"
import { saveDocx } from "@filen/office/core/docx/write"
import { fallbackCopy } from "../core/docx/write/nested"
import { survivorsOf, type MarkerList } from "../core/docx/edit/schema"
import { SetMarksStep } from "../core/docx/edit/marks"
import { RICH, markerKeys, openBytes, openSpec, sessionOf } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"

function sectionHolders(doc: Node): number[] {
	const out: number[] = []

	doc.descendants(node => {
		const sectPr = node.attrs["sectPr"]

		if (node.isBlock && typeof sectPr === "number" && sectPr !== NO_SOURCE) out.push(sectPr)

		return !node.isTextblock
	})

	return out.sort((a, b) => a - b)
}

// Position of the first text containing `text`, plus `offset`.
function find(doc: Node, text: string, offset: number = 0): number {
	let found = -1

	doc.descendants((node, pos) => {
		if (found >= 0) return false

		if (node.isText && node.text?.includes(text) === true) found = pos + node.text.indexOf(text) + offset

		return true
	})

	if (found < 0) throw new Error(`no "${text}"`)

	return found
}

function blockPos(doc: Node, index: number): number {
	let pos = 0

	for (let k = 0; k < index; k++) pos += doc.child(k).nodeSize

	return pos
}

function run(session: DocxEditorSession, build: (state: EditorState) => Transaction): boolean {
	return session.dispatch(build(session.state))
}

// A small deterministic PRNG (mulberry32).
function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

describe("docx editing invariants", () => {
	// The builder makes nodes from complete attribute objects (schema.ts makeNode): one missing an attribute
	// differs from the same node made by create(), so an undo back to it is not equal.
	it("builds every node and mark with each attribute its schema declares", async () => {
		const session = await sessionOf(RICH)
		const missing = new Set<string>()
		const check = (name: string, attrs: object, declared: object | undefined): void => {
			const have = Object.keys(attrs).sort().join()
			const want = Object.keys(declared ?? {})
				.sort()
				.join()

			if (have !== want) missing.add(`${name}: ${have} != ${want}`)
		}

		session.state.doc.descendants(node => {
			check(node.type.name, node.attrs, node.type.spec.attrs)

			for (const mark of node.marks) check(mark.type.name, mark.attrs, mark.type.spec.attrs)
		})
		check("doc", session.state.doc.attrs, docxSchema.nodes.doc.spec.attrs)
		expect([...missing]).toEqual([])
	})

	it("puts back range markers a deletion took out, except a comment's taken whole with its reference", async () => {
		const session = await sessionOf(RICH)
		const before = markerKeys(session.state.doc)
		const doc = session.state.doc
		// From inside "Bold" to after the comment range: bookmark 0, comment range 3 and its reference go; the
		// bookmark's markers come back, the comment goes with them (as in Word).
		const from = find(doc, "Bold", 1)
		const to = find(doc, "c", 1) + 2

		expect(run(session, state => state.tr.delete(from, to))).toBe(true)
		expect(markerKeys(session.state.doc)).toEqual(before.filter(key => !key.startsWith("comment")))
		// They sit where the deletion was.
		const paragraph = session.state.doc.child(0)

		expect(paragraph.child(1).text).toBe("B")
		expect(paragraph.child(2).type.name).toBe("marker")
	})

	it("keeps the markers of a deleted table", async () => {
		const session = await sessionOf(RICH)
		const before = markerKeys(session.state.doc)
		const start = blockPos(session.state.doc, 1)
		const table = session.state.doc.child(1)

		expect(run(session, state => state.tr.delete(start, start + table.nodeSize))).toBe(true)
		expect(session.state.doc.child(1).type.name).toBe("paragraph")
		expect(markerKeys(session.state.doc)).toEqual(before)
	})

	it("keeps a block's leading markers when it is joined into the previous one", async () => {
		const session = await sessionOf({
			body: p("one") + '<w:bookmarkStart w:id="4" w:name="b"/>' + p("two") + '<w:bookmarkEnd w:id="4"/>' + p("three")
		})
		const before = markerKeys(session.state.doc)
		const join = session.state.doc.child(0).nodeSize

		expect(run(session, state => state.tr.join(join))).toBe(true)
		expect(session.state.doc.childCount).toBe(2)
		expect(markerKeys(session.state.doc)).toEqual(before)
		expect(session.state.doc.child(0).textContent).toBe("onetwo")
	})

	it("keeps a range over a paragraph when blocks after it move, and when it moves away and back", async () => {
		const body =
			'<w:p><w:bookmarkStart w:id="0" w:name="_GoBack"/><w:r><w:t>zero</w:t></w:r></w:p><w:bookmarkEnd w:id="0"/>' +
			p("one") +
			p("two") +
			p("three")
		// Moves top-level blocks first..last to before block `target`, as a drop does.
		const move = (session: DocxEditorSession, first: number, last: number, target: number): boolean =>
			run(session, state => {
				const doc = state.doc
				let from = 0
				let at = 0

				for (let k = 0; k < first; k++) from += doc.child(k).nodeSize
				for (let k = 0; k < target; k++) at += doc.child(k).nodeSize

				let to = from

				for (let k = first; k <= last; k++) to += doc.child(k).nodeSize

				const tr = state.tr.delete(from, to)
				const mapped = tr.mapping.map(at)

				return tr.replaceRange(mapped, mapped, doc.slice(from, to))
			})
		// Each top-level block's text with the range's markers around it.
		const shown = (session: DocxEditorSession): string[] => {
			const out: string[] = []

			session.state.doc.forEach(node => {
				const before = (node.attrs["before"] as MarkerList).map(marker => `<${marker.kind}>`).join("")
				let text = ""

				node.forEach(child => (text += child.isText ? (child.text ?? "") : `<${String(child.attrs["kind"])}>`))
				out.push(before + text)
			})

			return out
		}

		// What follows it moves before it: the range keeps to the paragraph.
		const after = await sessionOf({ body })

		expect(move(after, 2, 2, 1)).toBe(true)
		expect(move(after, 1, 2, 0)).toBe(true)
		expect(shown(after)).toEqual(["two", "one", "<bookmarkStart>zero", "<bookmarkEnd>three"])

		// The paragraph moves past the next one and back: the document is as it was.
		const back = await sessionOf({ body })
		const original = back.state.doc

		expect(move(back, 0, 0, 2)).toBe(true)
		expect(move(back, 1, 1, 0)).toBe(true)
		expect(back.state.doc.eq(original)).toBe(true)
	})

	it("refuses to join across a section break and moves the break with a split", async () => {
		const session = await sessionOf({
			body:
				p("before") +
				'<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>end of section</w:t></w:r></w:p>' +
				p("after")
		})
		const doc = session.state.doc
		const section = doc.child(0).nodeSize
		const sectPr = doc.child(1).attrs["sectPr"] as number

		expect(sectPr).toBe(doc.child(1).attrs["src"])
		// Delete at the end of the section's last paragraph and the paragraph deleted whole take its mark.
		expect(run(session, state => state.tr.join(section + doc.child(1).nodeSize))).toBe(false)
		expect(run(session, state => state.tr.delete(section, section + doc.child(1).nodeSize))).toBe(false)
		expect(session.state.doc).toBe(doc)
		// Editing inside it is fine.
		expect(run(session, state => state.tr.insertText("!", section + 1))).toBe(true)

		// Enter in the middle: the second half ends the section.
		expect(run(session, state => state.tr.split(find(state.doc, "of section")))).toBe(true)

		const split = session.state.doc

		expect(split.child(1).attrs["sectPr"]).toBe(NO_SOURCE)
		expect(split.child(2).attrs["sectPr"]).toBe(sectPr)
		expect(split.child(2).textContent).toBe("of section")
		expect(sectionHolders(split)).toEqual(sectionHolders(doc))

		// Undo restores the paragraph, break included.
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(doc)).toBe(true)
	})

	it("deletes fields whole and refuses to delete locked blocks that hold structure", async () => {
		const session = await sessionOf(RICH)
		const doc = session.state.doc
		const fieldPos = find(doc, "gone", 4)

		expect(doc.nodeAt(fieldPos)?.type.name).toBe("field")
		expect(run(session, state => state.tr.delete(fieldPos, fieldPos + 1))).toBe(true)
		expect(session.state.doc.child(0).childCount).toBe(doc.child(0).childCount - 1)

		const toc = blockPos(session.state.doc, 3)

		expect(run(session, state => state.tr.delete(toc, toc + 1))).toBe(false)
		expect(run(session, state => state.tr.setSelection(NodeSelection.create(state.doc, toc)).deleteSelection())).toBe(false)

		// The content-locked control and the altChunk may go as a whole.
		const control = blockPos(session.state.doc, 6)

		expect(session.state.doc.child(6).attrs["reason"]).toBe("contentLocked")
		expect(run(session, state => state.tr.delete(control, control + 1))).toBe(true)
		expect(session.state.doc.child(6).attrs["reason"]).toBe("altChunk")
	})

	it("refuses to delete a content control locked against deletion", async () => {
		const session = await sessionOf(RICH)
		const doc = session.state.doc
		const control = blockPos(doc, 5)

		expect(run(session, state => state.tr.delete(control, control + doc.child(5).nodeSize))).toBe(false)
		// Its content stays editable.
		expect(run(session, state => state.tr.insertText("x", find(state.doc, "in control")))).toBe(true)
	})

	it("keeps deleted text read-only and new text out of others' revisions", async () => {
		const session = await sessionOf(RICH)

		expect(run(session, state => state.tr.insertText("x", find(state.doc, "gone", 2)))).toBe(false)

		const inside = find(session.state.doc, "inserted", 3)

		expect(run(session, state => state.tr.setSelection(TextSelection.create(state.doc, inside)).insertText("NEW"))).toBe(true)

		const paragraph = session.state.doc.child(0)
		const pieces: [string, string[]][] = []

		paragraph.forEach(child => {
			if (child.isText) pieces.push([child.text ?? "", child.marks.map(mark => mark.type.name)])
		})

		// The new text is in the run it was typed into, outside the revision.
		expect(pieces).toContainEqual(["NEW", ["run"]])
		expect(pieces).toContainEqual(["ins", ["insertion", "run"]])
		expect(pieces).toContainEqual(["erted", ["insertion", "run"]])
	})

	it("refuses every change in read-only mode", async () => {
		const session = await sessionOf(RICH, { readOnly: true })
		const doc = session.state.doc

		expect(run(session, state => state.tr.insertText("x", 2))).toBe(false)
		expect(run(session, state => state.tr.setSelection(TextSelection.create(state.doc, 3)))).toBe(true)
		expect(session.state.doc).toBe(doc)
		expect(session.state.selection.from).toBe(3)
	})

	it("strips source identity from pasted content", async () => {
		const session = await sessionOf(RICH)
		const doc = session.state.doc
		const slice = freshSlice(doc.slice(0, blockPos(doc, 4)))
		const seen: string[] = []

		slice.content.descendants(node => {
			seen.push(node.type.name)

			if ("src" in node.attrs) expect(node.attrs["src"], node.type.name).toBe(NO_SOURCE)
			if ("sectPr" in node.attrs) expect(node.attrs["sectPr"]).toBe(NO_SOURCE)
			if ("before" in node.attrs) expect(node.attrs["before"]).toEqual([])

			for (const mark of node.marks) {
				expect(["insertion", "deletion", "content_control", "wrapper", "format_change"]).not.toContain(mark.type.name)

				if (mark.type.name === "link") expect(mark.attrs["src"]).toBe(NO_SOURCE)
			}

			return true
		})

		expect(seen).not.toContain("marker")
		expect(seen).not.toContain("comment_ref")
		expect(seen).not.toContain("math")
		expect(seen).toContain("field")
		// The index paragraph comes back as its text.
		expect(slice.content.lastChild?.textContent).toBe("Entry 1")
		// Pasted content keeps formatting and goes in.
		const end = session.state.doc.content.size

		expect(run(session, state => state.tr.replace(end, end, new Slice(slice.content, 0, 0)))).toBe(true)
		expect(markerKeys(session.state.doc)).toEqual(markerKeys(doc))
	})

	it("normalises list attributes", () => {
		expect(normalizeListAttrs({ numId: null, ilvl: 3 })).toEqual({ numId: null, ilvl: null })
		expect(normalizeListAttrs({ numId: 4, ilvl: 12 })).toEqual({ numId: 4, ilvl: 8 })
		expect(normalizeListAttrs({ numId: 4, ilvl: -1 })).toEqual({ numId: 4, ilvl: 0 })
		expect(normalizeListAttrs({ numId: 4, ilvl: 2 })).toBeUndefined()
		// Out of any list (numId 0): the level is left as the file has it.
		expect(normalizeListAttrs({ numId: 0, ilvl: 12 })).toBeUndefined()
	})

	it("runs list normalisation hooks on changed paragraphs", async () => {
		const session = await sessionOf(
			{ body: p("a") + p("b") },
			{ normalizeList: attrs => (attrs.numId === 7 ? { numId: 8, ilvl: attrs.ilvl } : undefined) }
		)

		expect(run(session, state => state.tr.setNodeAttribute(0, "numId", 7).setNodeAttribute(0, "ilvl", 20))).toBe(true)
		expect(session.state.doc.child(0).attrs).toMatchObject({ numId: 8, ilvl: 8 })
		expect(session.state.doc.child(1).attrs).toMatchObject({ numId: null, ilvl: null })
	})

	it("holds every invariant under random deletions, joins, splits and inserts", { timeout: 120_000 }, async () => {
		for (let seed = 1; seed <= Number(process.env["FUZZ_SEEDS"] ?? 12); seed++) {
			const session = await sessionOf(RICH, { historyDepth: 10_000 })
			const next = random(seed)
			const opened = session.state.doc
			const markers = markerKeys(session.state.doc)
			const sections = sectionHolders(session.state.doc)
			let applied = 0

			for (let round = 0; round < Number(process.env["FUZZ_ROUNDS"] ?? 150); round++) {
				const state = session.state
				const size = state.doc.content.size
				const a = Math.floor(next() * (size + 1))
				const b = Math.min(size, a + Math.floor(next() * (next() < 0.8 ? 40 : 400)))
				const choice = next()
				let tr: Transaction | null = null

				try {
					if (choice < 0.45) {
						tr = state.tr.delete(a, b)
					} else if (choice < 0.6) {
						if (canJoin(state.doc, a)) tr = state.tr.join(a)
					} else if (choice < 0.75) {
						if (state.doc.resolve(a).parent.inlineContent && canSplit(state.doc, a)) tr = state.tr.split(a)
					} else if (choice < 0.9) {
						if (state.doc.resolve(a).parent.inlineContent) tr = state.tr.insertText("xy", a)
					} else if (choice < 0.95) {
						tr = state.tr.replace(a, b, new Slice(Fragment.from(docxSchema.text("pasted")), 0, 0))
					} else {
						// Copy and paste inside the document.
						const c = Math.floor(next() * (size + 1))

						tr = state.tr.replace(a, b, freshSlice(state.doc.slice(c, Math.min(size, c + Math.floor(next() * 300)))))
					}
				} catch {
					tr = null
				}

				if (tr === null || !tr.docChanged) continue

				const previous = session.state.doc

				if (session.dispatch(tr)) applied++

				if (process.env["FUZZ_DEBUG"] !== undefined && markerKeys(session.state.doc).length !== markers.length) {
					console.log(
						seed,
						round,
						JSON.stringify(tr.steps.map(step => step.toJSON())),
						"\nBEFORE",
						previous.toString().slice(0, 3000),
						"\nAFTER",
						session.state.doc.toString().slice(0, 3000)
					)
				}

				const doc = session.state.doc

				doc.check()
				// Every marker stays, except comments taken whole (start, end and reference together).
				const keys = markerKeys(doc)
				const comments = new Set(keys.filter(key => key.startsWith("comment")).map(key => key.slice(key.indexOf(":"))))

				expect(keys, `seed ${seed} round ${round}`).toEqual(
					markers.filter(key => !key.startsWith("comment") || comments.has(key.slice(key.indexOf(":"))))
				)
				expect(sectionHolders(doc), `seed ${seed} round ${round}`).toEqual(sections)

				let lockedDeletable = 0

				doc.descendants(node => {
					if (node.type.name === "locked_block" && node.attrs["deletable"] !== true) lockedDeletable++

					return !node.isTextblock
				})

				expect(lockedDeletable).toBe(2)
			}

			expect(applied).toBeGreaterThan(20)

			// Everything undoes back to the opened document.
			while (session.execute({ type: "history.undo" })) {
				// undo all
			}

			expect(session.state.doc.eq(opened)).toBe(true)
			expect(session.snapshot().dirty).toBe(false)
		}
	})

	it("puts a comment range a block move turned around back in order, collapsed where its end went", async () => {
		const opened = await openSpec({
			body:
				'<w:p><w:commentRangeStart w:id="9"/><w:r><w:t>Start</w:t></w:r></w:p>' +
				p("Middle") +
				'<w:commentRangeEnd w:id="9"/><w:p><w:r><w:commentReference w:id="9"/></w:r><w:r><w:t>End</w:t></w:r></w:p>' +
				p("After"),
			comments: '<w:comment w:id="9" w:author="Bo"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment>'
		})
		const session = new DocxEditorSession(opened.context)
		const doc = session.state.doc
		const from = doc.child(0).nodeSize + doc.child(1).nodeSize
		const to = from + doc.child(2).nodeSize
		const tr = session.state.tr.delete(from, to)

		// The paragraph holding the end (in its marker list) and the reference dragged to the top.
		tr.replaceRange(0, 0, doc.slice(from, to))
		expect(session.dispatch(tr)).toBe(true)

		const order: string[] = []

		session.state.doc.descendants(node => {
			for (const marker of survivorsOf(node)) if (marker.id === "9") order.push(marker.kind)
			if (node.isBlock)
				for (const marker of (node.attrs["before"] ?? []) as MarkerList) if (marker.id === "9") order.push(marker.kind)

			return true
		})
		expect(order).toEqual(["commentRangeStart", "commentRangeEnd", "commentReference"])
		await expect(saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })).resolves.toBeDefined()
	})

	it("keeps the row and cell properties of a pasted copy of a source row", async () => {
		const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
		const opened = await openSpec({
			body:
				'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
				`<w:tr><w:trPr><w:gridBefore w:val="1"/><w:wBefore w:w="1000" w:type="dxa"/></w:trPr>${cell("one")}</w:tr></w:tbl>` +
				p("after")
		})
		const session = new DocxEditorSession(opened.context)
		const table = session.state.doc.child(0)
		const row = table.child(0)

		// The row pasted again below itself.
		expect(session.dispatch(session.state.tr.insert(1 + row.nodeSize, row))).toBe(true)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/document.xml"])

		expect(xml.match(/<w:gridBefore w:val="1"\/>/g)).toHaveLength(2)
		expect(xml.match(/<w:tcW w:w="3000" w:type="dxa"\/>/g)).toHaveLength(2)
	})

	const SHADED = (fills: readonly string[]): string =>
		'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>' +
		fills
			.map(
				(fill, k) =>
					`<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${fill === "" ? "" : `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`}` +
					`<w:vAlign w:val="center"/></w:tcPr>${p(`c${String(k)}`)}</w:tc>`
			)
			.join("") +
		"</w:tr></w:tbl>"

	async function cellsOf(opened: Awaited<ReturnType<typeof openSpec>>, sessions: DocxEditorSession[], name: string): Promise<string[]> {
		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions })
		const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)[name])

		return (xml.match(/<w:tcPr>.*?<\/w:tcPr>/g) ?? []) as string[]
	}

	for (const tracked of [false, true]) {
		it(`keeps a cell's fill in a pasted copy of its table, its change record with the original (${tracked ? "tracked" : "untracked"})`, async () => {
			const opened = await openSpec({ body: SHADED(["", "00FF00"]) + p("after") })
			const session = new DocxEditorSession(opened.context)

			session.context.review.tracking = tracked
			session.context.identity.author = "Ann"
			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, find(session.state.doc, "c0"))))
			expect(session.execute({ type: "table.cell.shading", fill: "123456" })).toBe(true)
			session.context.review.tracking = false

			const table = session.state.doc.child(0)

			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, find(session.state.doc, "after"))))
			expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(0, table.nodeSize)))).toBe(true)

			const cells = await cellsOf(opened, [session], "word/document.xml")

			expect(cells).toHaveLength(4)
			expect(cells.filter(cell => cell.includes('w:fill="123456"'))).toHaveLength(2)
			expect(cells.filter(cell => cell.includes('w:fill="00FF00"'))).toHaveLength(2)
			expect(cells.filter(cell => cell.includes('<w:vAlign w:val="center"/>'))).toHaveLength(4)
			expect(cells.filter(cell => cell.includes("tcPrChange"))).toHaveLength(tracked ? 1 : 0)
		})
	}

	it("keeps the cells' properties in a drag copy (the paste sanitiser)", async () => {
		const opened = await openSpec({ body: SHADED(["FF0000", "00FF00"]) + p("after") })
		const session = new DocxEditorSession(opened.context)
		const table = session.state.doc.child(0)

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, find(session.state.doc, "after"))))
		expect(session.dispatch(session.state.tr.replaceSelection(freshSlice(session.state.doc.slice(0, table.nodeSize))))).toBe(true)

		const cells = await cellsOf(opened, [session], "word/document.xml")

		expect(cells.filter(cell => cell.includes('w:fill="FF0000"') && cell.includes('<w:tcW w:w="2000" w:type="dxa"/>'))).toHaveLength(2)
	})

	it("keeps a pasted table's own properties, its tracked change with the original", async () => {
		const tblPr =
			'<w:tblW w:w="4000" w:type="dxa"/><w:jc w:val="center"/><w:tblInd w:w="144" w:type="dxa"/>' +
			'<w:tblBorders><w:top w:val="double" w:sz="4" w:space="0" w:color="FF0000"/></w:tblBorders><w:tblLayout w:type="fixed"/>' +
			'<w:tblCellMar><w:left w:w="57" w:type="dxa"/></w:tblCellMar>'
		const change =
			'<w:tblPrChange w:id="5" w:author="Ann" w:date="2026-01-01T00:00:00Z"><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr></w:tblPrChange>'
		const body =
			SHADED(["", ""]).replace('<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>', `<w:tblPr>${tblPr}${change}</w:tblPr>`) +
			p("after")

		for (const kind of ["raw", "fresh", "open"] as const) {
			const opened = await openSpec({ body })
			const session = new DocxEditorSession(opened.context)
			const size = session.state.doc.child(0).nodeSize
			// "open": the slice ends inside the table's last cell (the copy is a table the paste opened).
			const slice = session.state.doc.slice(0, kind === "open" ? find(session.state.doc, "c1") + 1 : size)

			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, find(session.state.doc, "after"))))
			expect(session.dispatch(session.state.tr.replaceSelection(kind === "fresh" ? freshSlice(slice) : slice))).toBe(true)

			const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
			const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/document.xml"])
			const tables = xml.match(/<w:tblPr>.*?<\/w:tblPr>(?=<w:tblGrid>)/g) ?? []

			expect(tables).toHaveLength(2)

			for (const table of tables) expect(table).toContain(tblPr)

			expect(tables.filter(table => table.includes("tblPrChange"))).toHaveLength(1)
		}
	})

	it("keeps the fill, alignment and width of another part's cells pasted, not that part's items as models", async () => {
		const opened = await openSpec({
			body: SHADED(["FF0000", "00FF00"]) + p("after") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: SHADED(["111111", "222222"]) + p("tail") }
		})
		const story = opened.context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")

		const body = new DocxEditorSession(opened.context)
		const header = new DocxEditorSession(opened.context, { story })
		const doc = body.state.doc
		// Both cells of the body's row, pasted into the header's last cell.
		const slice = doc.slice(find(doc, "c0") - 2, find(doc, "c1") + 4)

		header.dispatch(header.state.tr.setSelection(TextSelection.create(header.state.doc, find(header.state.doc, "c1") + 2)))
		expect(header.dispatch(header.state.tr.replaceSelection(slice))).toBe(true)

		const cells = await cellsOf(opened, [body, header], "word/header1.xml")

		expect(cells.filter(cell => cell.includes('w:fill="111111"'))).toHaveLength(1)
		expect(cells.filter(cell => cell.includes('w:fill="FF0000"') && cell.includes('<w:tcW w:w="2000" w:type="dxa"/>'))).toHaveLength(1)
		expect(cells.filter(cell => cell.includes('w:fill="00FF00"') && cell.includes('<w:vAlign w:val="center"/>'))).toHaveLength(1)
	})

	const PAGE =
		'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'

	// The saved body's paragraphs as their text, a section-ending one followed by its left margin.
	async function savedBody(opened: Awaited<ReturnType<typeof pagedEditor>>): Promise<string[]> {
		await settleAll(opened.editor)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })
		const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/document.xml"])

		return (xml.match(/<w:p[ >].*?<\/w:p>/g) ?? []).map(
			paragraph =>
				[...paragraph.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join("") +
				(paragraph.includes("<w:sectPr>") ? ` | ${paragraph.match(/<w:pgMar [^>]*w:left="(\d+)"/)?.[1] ?? ""}` : "")
		)
	}

	for (const [tracked, kind] of [
		[false, "fresh"],
		[true, "fresh"],
		[false, "raw"],
		[true, "raw"]
	] as const) {
		it(`keeps a section's page setup with its break when paragraphs are pasted into the paragraph ending it (${tracked ? "tracked" : "untracked"}, ${kind})`, async () => {
			const opened = await pagedEditor(
				buildDocx({
					body:
						`<w:p><w:pPr><w:sectPr>${PAGE}</w:sectPr></w:pPr><w:r><w:t>Pag</w:t></w:r></w:p>` +
						p("e 1") +
						p("x") +
						`<w:sectPr>${PAGE}</w:sectPr>`
				})
			)
			const { editor, context } = opened
			const session = editor.body.session

			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 2)))
			expect(await editor.execute({ type: "page.setup", margins: { left: 2000 } })).toBe(true)
			context.identity.author = "T"
			context.review.tracking = tracked

			const doc = session.state.doc
			// "raw": a slice ending after a whole paragraph (the half after it is a new paragraph like the one split).
			const slice =
				kind === "fresh"
					? freshSlice(doc.slice(find(doc, "e 1", 1), find(doc, "x", 1)))
					: doc.slice(find(doc, "e 1", 1), doc.content.size)

			// Splits "Pag" after "Pa": the paragraph mark holding the break (and its page setup) ends the last half.
			session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, 3)).replaceSelection(slice))
			expect(await savedBody(opened)).toEqual(
				kind === "fresh" ? ["Pa 1", "xg | 2000", "e 1", "x"] : ["Pa 1", "x", "g | 2000", "e 1", "x"]
			)
			editor.dispose()
		})
	}

	it("moves the break to the last paragraph when paragraphs are pasted into the paragraph ending a section", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body:
					p("One two") +
					p("Three four") +
					`<w:p><w:pPr><w:sectPr>${PAGE}</w:sectPr></w:pPr><w:r><w:t>Break here</w:t></w:r></w:p>` +
					p("After") +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const session = opened.editor.body.session
		const doc = session.state.doc

		session.dispatch(
			session.state.tr
				.setSelection(TextSelection.create(doc, find(doc, "Break", 3)))
				.replaceSelection(freshSlice(doc.slice(2, find(doc, "Three", 3))))
		)
		expect(await savedBody(opened)).toEqual(["One two", "Three four", "Brene two", "Thrak here | 1440", "After"])
		opened.editor.dispose()
	})

	it("finds the copies a paste inserted when a later step of the same edit rebuilds them", async () => {
		const opened = await openSpec({
			body:
				p("one") +
				'<w:p><w:bookmarkStart w:id="3" w:name="mark"/><w:r><w:t>two</w:t></w:r><w:bookmarkEnd w:id="3"/></w:p>' +
				'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>' +
				p("cell") +
				"</w:tc></w:tr></w:tbl>" +
				p("end")
		})
		const session = new DocxEditorSession(opened.context)
		const doc = session.state.doc
		const copied = doc.slice(doc.child(0).nodeSize, doc.content.size - doc.lastChild!.nodeSize)

		// A transformer taking the pasted blocks out and putting them back (as a forms rebuild does).
		const tr = session.state.tr.insert(doc.content.size, copied.content)
		const from = doc.content.size

		tr.replaceWith(from, tr.doc.content.size, tr.doc.slice(from).content)
		expect(session.dispatch(tr)).toBe(true)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/document.xml"])

		expect(xml.match(/<w:bookmarkStart /g)).toHaveLength(1)
		expect(xml.match(/<w:tbl>/g)).toHaveLength(2)
	})

	it("makes a copy of part of a content control a control of its own, and keeps the one typed into", async () => {
		const control =
			'<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="104"/><w:text/></w:sdtPr><w:sdtContent>' +
			"<w:r><w:t>Click here</w:t></w:r></w:sdtContent></w:sdt></w:p>"

		for (const edit of ["copy", "type"] as const) {
			const opened = await openSpec({ body: control + p("End") })
			const session = new DocxEditorSession(opened.context)
			const doc = session.state.doc
			const at = find(doc, "Click")

			// Part of it copied after "End" (a drag copy: no paste sanitiser), or typed into.
			const tr =
				edit === "copy"
					? session.state.tr.insert(find(doc, "End", 3), doc.slice(at + 1, at + 6).content)
					: session.state.tr.insertText("!", at + 2)

			expect(session.dispatch(tr)).toBe(true)

			const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
			const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/document.xml"])

			expect(xml.match(/<w:sdt>/g)).toHaveLength(edit === "copy" ? 2 : 1)
			expect(xml.match(/<w:id w:val="104"\/>/g)).toHaveLength(1)
			expect(xml).toContain(edit === "copy" ? "Click here" : "Cl!ick here")
		}
	})

	// Pasted, dropped, converted or cut and pasted from one part into another (here the body into a header).
	const COPIED_TABLE =
		'<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="6000" w:type="dxa"/><w:tblInd w:w="144" w:type="dxa"/>' +
		'<w:tblBorders><w:top w:val="double" w:sz="4" w:space="0" w:color="FF0000"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>' +
		'<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="700"/></w:trPr>' +
		'<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:tcBorders><w:left w:val="dotted" w:sz="8" w:space="0" w:color="00FF00"/></w:tcBorders>' +
		'<w:shd w:val="clear" w:color="auto" w:fill="DDDDDD" w:themeFill="accent1" w:themeFillTint="33"/><w:tcMar><w:top w:w="72" w:type="dxa"/></w:tcMar></w:tcPr>' +
		p("A1") +
		'</w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' +
		p("B1") +
		"</w:tc></w:tr></w:tbl>"
	const COPIED_CONTROLS =
		'<w:p><w:r><w:t xml:space="preserve">Agree </w:t></w:r><w:sdt><w:sdtPr><w:tag w:val="agree"/><w:id w:val="101"/><w14:checkbox>' +
		'<w14:checked w14:val="1"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/>' +
		"</w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>\u2612</w:t></w:r></w:sdtContent></w:sdt></w:p>" +
		'<w:sdt><w:sdtPr><w:alias w:val="When"/><w:id w:val="103"/><w:date w:fullDate="2026-10-12T00:00:00Z"><w:dateFormat w:val="d MMMM yyyy"/>' +
		'<w:lid w:val="en-GB"/></w:date></w:sdtPr><w:sdtContent>' +
		p("12 October 2026") +
		"</w:sdtContent></w:sdt>"

	for (const how of ["raw", "fresh", "cut"] as const) {
		it(`keeps the properties of tables and content controls copied into another part (${how})`, async () => {
			const opened = await openSpec({
				body: COPIED_TABLE + COPIED_CONTROLS + p("End") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
				headers: { rIdH: p("Head") }
			})
			const story = opened.context.model.stories.find(entry => entry.kind === "header")

			if (story === undefined) throw new Error("no header")

			const body = new DocxEditorSession(opened.context)
			const header = new DocxEditorSession(opened.context, { story })
			const doc = body.state.doc
			const copied = doc.slice(0, doc.content.size - doc.child(doc.childCount - 1).nodeSize)
			const from = body.story.part.index
			const to = header.story.part.index
			const slice =
				how === "raw"
					? copied
					: how === "fresh"
						? freshSlice(copied, sourceCopies(opened.context), from, to)
						: freshSliceKeeping(copied, new Set(), sourceCopies(opened.context), from, to)

			if (how === "cut") expect(body.dispatch(body.state.tr.delete(0, copied.size))).toBe(true)

			header.dispatch(header.state.tr.setSelection(TextSelection.create(header.state.doc, find(header.state.doc, "Head", 4))))
			expect(header.dispatch(header.state.tr.replaceSelection(slice))).toBe(true)

			const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [body, header] })
			const files = unzipSync(result.bytes as Uint8Array)
			const xml = new TextDecoder().decode(files["word/header1.xml"])

			expect(xml).toContain(
				'<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="6000" w:type="dxa"/><w:tblInd w:w="144" w:type="dxa"/>' +
					'<w:tblBorders><w:top w:val="double" w:sz="4" w:space="0" w:color="FF0000"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>'
			)
			expect(xml).toContain('<w:trPr><w:cantSplit/><w:trHeight w:val="700"/></w:trPr>')
			expect(xml).toContain(
				'<w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:tcBorders><w:left w:val="dotted" w:sz="8" w:space="0" w:color="00FF00"/></w:tcBorders>' +
					'<w:shd w:val="clear" w:color="auto" w:fill="DDDDDD" w:themeFill="accent1" w:themeFillTint="33"/><w:tcMar><w:top w:w="72" w:type="dxa"/></w:tcMar></w:tcPr>'
			)
			// The controls, without the original's ids.
			expect(xml).toContain(
				'<w:sdt><w:sdtPr><w:tag w:val="agree"/><w14:checkbox><w14:checked w14:val="1"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/>'
			)
			expect(xml).toContain('<w:sdt><w:sdtPr><w:alias w:val="When"/><w:date w:fullDate="2026-10-12T00:00:00Z">')
			expect(xml).not.toContain("w:id=")
		})
	}

	it("models a table converted into a note of the other kind on its own properties, not on that part's table", async () => {
		const table = (color: string, fill: string): string =>
			`<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders><w:top w:val="double" w:sz="4" w:space="0" w:color="${color}"/></w:tblBorders></w:tblPr>` +
			'<w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>' +
			`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>${p("A1")}</w:tc></w:tr></w:tbl>`
		const separators = (kind: string): string =>
			`<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>` +
			`<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`
		const note = (kind: string, mark: string, color: string, fill: string): string =>
			`<w:${kind} w:id="1"><w:p><w:r><w:${mark}/></w:r><w:r><w:t xml:space="preserve"> note</w:t></w:r></w:p>${table(color, fill)}<w:p/></w:${kind}>`
		const opened = await pagedEditor(
			buildDocx({
				body:
					'<w:p><w:r><w:t>One</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' +
					'<w:p><w:r><w:t>Two</w:t></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>',
				footnotes: separators("footnote") + note("footnote", "footnoteRef", "FF0000", "FFFF00"),
				endnotes: separators("endnote") + note("endnote", "endnoteRef", "00FF00", "0000FF")
			})
		)
		const { editor, context } = opened
		const body = editor.body.session

		body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, 4)))
		expect(await editor.execute({ type: "note.convert" })).toBe(true)
		await settleAll(editor)

		const result = await saveDocx({ pkg: opened.pkg, context, sessions: editor.sessions })
		const endnotes = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/endnotes.xml"])
		const converted = endnotes.slice(endnotes.indexOf('<w:endnote w:id="2"'))

		expect(converted).toContain('w:color="FF0000"')
		expect(converted).toContain('w:fill="FFFF00"')
		expect(converted).not.toContain("00FF00")
		editor.dispose()
	})

	it("does not look up where the document came from for typing or Enter, only for content pasted", async () => {
		const opened = await openSpec({ body: p("one") + p("two") + p("three") })
		const session = new DocxEditorSession(opened.context)
		const last = session.state.doc.child(2)

		// Typed text takes the caret's source run; Enter copies its paragraph's attributes.
		expect(session.dispatch(session.state.tr.insertText("x", 2))).toBe(true)
		expect(session.dispatch(session.state.tr.split(3))).toBe(true)
		expect(originOf(last)).toBeUndefined()

		expect(session.dispatch(session.state.tr.insert(session.state.doc.content.size, last.copy(last.content)))).toBe(true)
		expect(originOf(last)).toBe(session.story.part.index)
	})

	it("writes a control copied into another part with that part's prefixes, markup compatibility tokens included", async () => {
		const W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
		const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
		const control =
			'<w:p><w:sdt><w:sdtPr mc:Ignorable="w14"><w:id w:val="9"/><mc:AlternateContent><mc:Choice Requires="w14">' +
			'<w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></mc:Choice><mc:Fallback/></mc:AlternateContent>' +
			'<w15:color w15:val="FF0000"/></w:sdtPr>' +
			"<w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>"
		const files = unzipSync(
			buildDocx({
				body: control + p("End") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
				headers: { rIdH: p("Head") }
			})
		)
		// The header binds w14 and mc to other prefixes and "ns1" to something else, and leaves w15 unbound.
		const header = new TextDecoder()
			.decode(files["word/header1.xml"])
			.replace(`xmlns:w14="${W14}"`, `xmlns:x14="${W14}" xmlns:ns1="urn:other"`)
			.replace(`xmlns:mc="${MC}"`, `xmlns:mx="${MC}"`)
			.replace('mc:Ignorable="w14 w15 wp14"', 'mx:Ignorable="x14"')
			.replace(' xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"', "")

		files["word/header1.xml"] = Uint8Array.from(new TextEncoder().encode(header))

		const opened = await openBytes(zipSync(files, { mtime: ZIP_ENTRY_TIME }))
		const story = opened.context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")

		const body = new DocxEditorSession(opened.context)
		const target = new DocxEditorSession(opened.context, { story })
		const slice = freshSlice(
			body.state.doc.slice(0, body.state.doc.child(0).nodeSize),
			sourceCopies(opened.context),
			body.story.part.index,
			target.story.part.index
		)

		target.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, find(target.state.doc, "Head", 4))))
		expect(target.dispatch(target.state.tr.replaceSelection(slice))).toBe(true)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [body, target] })
		const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/header1.xml"])

		expect(xml).toContain(
			// w15, ignorable in the body but not in the header, stays ignorable where it is used.
			'<w:sdtPr mx:Ignorable="x14 ns2" xmlns:ns2="http://schemas.microsoft.com/office/word/2012/wordml"><mx:AlternateContent>' +
				'<mx:Choice Requires="x14"><x14:checkbox><x14:checked x14:val="1"/>'
		)
		// w15, which the header does not bind, under a prefix it leaves free.
		expect(xml).toContain('<ns2:color ns2:val="FF0000" xmlns:ns2="http://schemas.microsoft.com/office/word/2012/wordml"/>')
	})

	it("keeps a section break with its paragraph mark when an edit joins into, or moves, the paragraph ending the section", async () => {
		const ending = `<w:p><w:pPr><w:sectPr>${PAGE}</w:sectPr></w:pPr><w:r><w:t>Break here</w:t></w:r></w:p>`
		const edits = {
			// Backspace at its start, a selection from the paragraph before into it typed over, its paragraph dragged
			// before the first.
			backspace: (state: EditorState): Transaction => state.tr.join(find(state.doc, "Break") - 1),
			typeOver: (state: EditorState): Transaction =>
				state.tr
					.setSelection(TextSelection.create(state.doc, find(state.doc, "two", 1), find(state.doc, "here", 1)))
					.insertText("X"),
			drag: (state: EditorState): Transaction => {
				const from = find(state.doc, "Break") - 1
				const to = find(state.doc, "here", 4) + 1
				const tr = state.tr.delete(from, to)

				return tr.insert(0, state.doc.slice(from, to).content)
			}
		}
		const expected = {
			backspace: ["One twoBreak here | 2000", "After"],
			typeOver: ["One tXere | 2000", "After"],
			drag: ["Break here | 2000", "One two", "After"]
		}

		for (const [name, edit] of Object.entries(edits) as [keyof typeof edits, (state: EditorState) => Transaction][]) {
			const opened = await pagedEditor(buildDocx({ body: p("One two") + ending + p("After") + `<w:sectPr>${PAGE}</w:sectPr>` }))
			const session = opened.editor.body.session

			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, find(session.state.doc, "Break", 1))))
			expect(await opened.editor.execute({ type: "page.setup", margins: { left: 2000 } })).toBe(true)
			expect(session.dispatch(edit(session.state))).toBe(true)
			expect(await savedBody(opened)).toEqual(expected[name])
			opened.editor.dispose()
		}
	})

	it("lets a closed session's document go", async () => {
		setFlagsFromString("--expose-gc")

		const gc = runInNewContext("gc") as () => void
		const opened = await openSpec({ body: p("one") + p("two") })
		const refs = (() => {
			const session = new DocxEditorSession(opened.context)

			session.dispatch(session.state.tr.insertText("x", 2))

			const ref = new WeakRef(session.state.doc)

			session.dispose()

			return ref
		})()

		await new Promise(resolve => setTimeout(resolve, 0))
		gc()
		expect(refs.deref()).toBeUndefined()
	})

	it("warms up a keystroke's code without changing anything", async () => {
		for (const tracking of [false, true]) {
			const opened = await openSpec({ body: p("one") + p("two") })
			const fresh = await openSpec({ body: p("one") + p("two") })

			opened.context.identity.author = "T"
			opened.context.review.tracking = tracking

			const session = new DocxEditorSession(opened.context)
			const state = session.state
			let applied = 0

			session.onApplied(() => applied++)
			session.warmUp()
			expect(session.state).toBe(state)
			expect(applied).toBe(0)
			expect(session.execute({ type: "history.undo" })).toBe(false)
			// No id handed out: a tracked change made next has the id it would have had.
			expect(opened.context.ids.next("revision")).toBe(fresh.context.ids.next("revision"))
			session.dispose()
		}
	})

	it("refuses to paste a copy of another part's control whose properties use a prefix that part does not bind", async () => {
		const control =
			'<w:p><w:sdt><w:sdtPr><w:id w:val="9"/><mc:AlternateContent><mc:Choice Requires="zz"><w:text/></mc:Choice>' +
			"<mc:Fallback/></mc:AlternateContent></w:sdtPr><w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>"
		const opened = await openSpec({
			body: control + p("End") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: p("Head") }
		})
		const story = opened.context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")

		const body = new DocxEditorSession(opened.context)
		const header = new DocxEditorSession(opened.context, { story })
		const slice = freshSlice(
			body.state.doc.slice(0, body.state.doc.child(0).nodeSize),
			sourceCopies(opened.context),
			body.story.part.index,
			header.story.part.index
		)
		const before = header.state.doc

		expect(header.dispatch(header.state.tr.insert(header.state.doc.content.size, slice.content))).toBe(false)
		expect(header.state.doc).toBe(before)
		// The document still saves.
		await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [body, header] })
	})

	it("leaves a run holding only a comment or note reference out of a text box's fallback copy, and keeps the source's empty runs", async () => {
		const opened = await openSpec({ body: p("x") })
		const part = opened.context.model.parts[0]

		if (part === undefined) throw new Error("no part")

		const content =
			'<w:txbxContent><w:p><w:r><w:t>a</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:commentReference w:id="1"/></w:r>' +
			'<w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:rPr><w:i/></w:rPr></w:r><w:r><w:commentReference w:id="1"/><w:t>b</w:t></w:r></w:p></w:txbxContent>'
		const copy = new TextDecoder().decode(fallbackCopy(part, new TextEncoder().encode(content), { next: () => 1 }))

		expect(copy).toBe(
			"<w:txbxContent><w:p><w:r><w:t>a</w:t></w:r><w:r><w:rPr><w:i/></w:rPr></w:r><w:r><w:t>b</w:t></w:r></w:p></w:txbxContent>"
		)
	})

	it("gives the bookmarks of two text box copies that replace no copy ids of their own", async () => {
		const opened = await openSpec({ body: p("x") })
		const part = opened.context.model.parts[0]

		if (part === undefined) throw new Error("no part")

		let next = 100
		const ids = { next: () => next++ }
		const content =
			'<w:txbxContent><w:p><w:bookmarkStart w:id="5" w:name="a"/><w:r><w:t>a</w:t></w:r><w:bookmarkEnd w:id="5"/></w:p></w:txbxContent>'
		const id = (copy: Uint8Array): string | undefined => /<w:bookmarkStart w:id="(\d+)"/.exec(new TextDecoder().decode(copy))?.[1]
		const first = id(fallbackCopy(part, new TextEncoder().encode(content), ids))
		const second = id(fallbackCopy(part, new TextEncoder().encode(content), ids))

		expect(first).toBe("100")
		expect(second).toBe("101")
	})

	it("undoes a piece mark step followed by a plain mark step of the same mark exactly", async () => {
		for (const plain of ["remove", "add", "appended"] as const) {
			const session = await sessionOf({ body: p("hello wonderful world") })
			const doc = session.state.doc
			const bold = docxSchema.marks.bold.create()
			const at = find(doc, "hello")
			// Bold on "ll" and "won", none on "o w" between them.
			const pieces = [
				{ from: at + 2, to: at + 4, mark: bold },
				{ from: at + 4, to: at + 7, mark: null },
				{ from: at + 7, to: at + 10, mark: bold }
			]
			const tr = session.state.tr.step(new SetMarksStep(pieces, bold))

			if (plain === "remove") tr.removeMark(at + 3, at + 12, bold)
			if (plain === "add") tr.addMark(at + 3, at + 12, bold)

			expect(session.dispatch(tr)).toBe(true)

			// A plain mark step in a transaction of its own (history may group it with the piece step's).
			if (plain === "appended") expect(session.dispatch(session.state.tr.removeMark(at + 3, at + 12, bold))).toBe(true)

			while (session.execute({ type: "history.undo" })) continue

			expect(session.state.doc.eq(doc)).toBe(true)
		}
	})
})

// The node marks a paragraph carries (docx schema BLOCK_MARKS; section_change is covered with its break in
// docxSections.test.ts), each on the first or the second of "Alpha" / "Bravo charlie", through each way of
// joining them.
describe("docx editing invariants: a joined paragraph's node marks", () => {
	const marks = docxSchema.marks
	const NODE_MARKS = {
		para_id: marks.para_id.create({ id: "1A2B3C4D" }),
		paragraph_change: marks.paragraph_change.create({ value: { author: "A", date: "2020-01-01T00:00:00Z", before: { align: null } } })
	}
	// Positions in "Alpha" (1..6) and "Bravo charlie" (8..21).
	const JOINS: Record<string, { readonly survivor: 0 | 1; readonly join: (session: DocxEditorSession) => void }> = {
		// ProseMirror rebuilds the end of "Bravo charlie" from its attributes alone: the paragraph mark is its.
		"a deletion from the start of the first into the second": {
			survivor: 1,
			join: session =>
				session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1, 9)).deleteSelection())
		},
		"a deletion from inside the first into the second": {
			survivor: 0,
			join: session =>
				session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 3, 9)).deleteSelection())
		},
		"Backspace at the start of the second": {
			survivor: 0,
			join: session => expect(joinAt(session, 8, joinBackward)).toBe(true)
		},
		"Delete at the end of the first": { survivor: 0, join: session => expect(joinAt(session, 6, joinForward)).toBe(true) }
	}

	for (const [name, mark] of Object.entries(NODE_MARKS)) {
		for (const on of [0, 1] as const) {
			for (const [label, { survivor, join }] of Object.entries(JOINS)) {
				it(`keeps ${name} on the ${on === 0 ? "first" : "second"} paragraph through ${label} where its attributes stay`, async () => {
					const opened = await openBytes(buildDocx({ body: p("Alpha") + p("Bravo charlie") + p("End") }))
					const session = new DocxEditorSession(opened.context)
					const doc = session.state.doc
					session.dispatch(markInternal(session.state.tr.addNodeMark(on === 0 ? 0 : doc.child(0).nodeSize, mark)))
					join(session)

					const joined = session.state.doc.child(0)

					expect(session.state.doc.childCount).toBe(2)
					// The joined paragraph is the one whose attributes it has, with its node marks: its own, or none.
					expect(joined.attrs["src"]).toBe(doc.child(survivor).attrs["src"])
					expect(joined.marks.map(kept => kept.type.name)).toEqual(survivor === on ? [name] : [])
				})
			}
		}
	}

	// The same deletion where the paragraphs are a table cell's or a block content control's.
	const CONTAINERS = {
		"a table cell": (inner: string) =>
			`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc></w:tr></w:tbl>`,
		"a block content control": (inner: string) =>
			`<w:sdt><w:sdtPr><w:id w:val="7"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`
	}

	for (const [container, wrap] of Object.entries(CONTAINERS)) {
		for (const [name, mark] of Object.entries(NODE_MARKS)) {
			it(`keeps ${name} of the second paragraph in ${container} through a deletion from the start of the first into it`, async () => {
				const opened = await openBytes(buildDocx({ body: p("Before") + wrap(p("Alpha") + p("Bravo charlie")) + p("After") }))
				const session = new DocxEditorSession(opened.context)
				const doc = session.state.doc
				const second = find(doc, "Bravo") - 1
				const src = doc.nodeAt(second)?.attrs["src"]

				session.dispatch(markInternal(session.state.tr.addNodeMark(second, mark)))
				session.dispatch(
					session.state.tr
						.setSelection(TextSelection.create(session.state.doc, find(doc, "Alpha"), find(doc, "Bravo", 1)))
						.deleteSelection()
				)

				const joined = session.state.doc.nodeAt(find(session.state.doc, "ravo charlie") - 1)

				expect(session.state.doc.textContent).toBe("Beforeravo charlieAfter")
				expect(joined?.attrs["src"]).toBe(src)
				expect(joined?.marks.map(kept => kept.type.name)).toEqual([name])
			})
		}
	}

	it("saves the tracked property change of a paragraph a deletion from the paragraph before rebuilt", async () => {
		const opened = await openBytes(buildDocx({ body: p("Alpha") + p("Bravo charlie") + p("End") }))
		const session = new DocxEditorSession(opened.context)

		opened.context.identity.author = "Tester"
		opened.context.review.tracking = true
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 10)))
		expect(session.execute({ type: "align.center" })).toBe(true)
		opened.context.review.tracking = false
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1, 9)).deleteSelection())

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const xml = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/document.xml"])

		expect(xml).toMatch(
			/<w:p><w:pPr><w:jc w:val="center"\/><w:pPrChange w:id="\d+" w:author="Tester" w:date="[^"]+"><w:pPr\/><\/w:pPrChange><\/w:pPr><w:r><w:t>ravo charlie<\/w:t><\/w:r><\/w:p>/
		)
	})
})

function joinAt(session: DocxEditorSession, pos: number, command: (state: EditorState) => Transaction | null | false): boolean {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))

	const tr = command(session.state)

	return tr !== null && tr !== false && session.dispatch(tr)
}
