import { describe, expect, it, vi } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RevisionView } from "../core/docx/model/kinds"
import { StoryCounters, markerCopy } from "../core/docx/reflow/counters"
import { runCss } from "../core/docx/reflow/css"
import { NUMBERING_PART, sessionOf } from "./docxEditFixtures"
import { buildDocx } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

// The reflowed view's list numbering: counted from checkpoints, so a window far into the document costs the
// blocks since the nearest checkpoint, and an edit counts again only what follows it.

function numbered(text: string): string {
	return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
}

const LIST = buildDocx({
	body: Array.from({ length: 300 }, (_, k) => numbered(`Item ${String(k)}`)).join(""),
	parts: [
		NUMBERING_PART(
			'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
				'<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
		)
	],
	relationships: [{ id: "rIdN", type: "numbering", target: "numbering.xml" }]
})

// The list markers of blocks [from, to) of the body, in order.
function markers(editor: PagedEditor, counters: StoryCounters, from: number, to: number): string[] {
	const doc = editor.body.session.state.doc
	const story = editor.body.edits
	const out: string[] = []

	counters.count(
		editor.body.session,
		doc,
		from,
		to,
		index => story.starts[index] ?? doc.content.size,
		(_pos, text) => out.push(text),
		() => undefined
	)

	return out
}

describe("reflow list numbering", () => {
	it("numbers a window from the nearest checkpoint and again after an edit before it", async () => {
		const { editor } = await pagedEditor(LIST)
		const session = editor.body.session
		const counters = new StoryCounters(editor, session)

		expect(markers(editor, counters, 250, 253)).toEqual(["251.", "252.", "253."])

		// The second time, only the blocks since the checkpoint before the window are read.
		const paragraph = vi.spyOn(session.formats, "paragraph")

		expect(markers(editor, counters, 260, 262)).toEqual(["261.", "262."])
		expect(paragraph.mock.calls.length).toBeLessThan(80)

		// A numbered paragraph added at the top: what follows counts one more.
		const at = session.state.doc.child(0).nodeSize

		session.dispatch(session.state.tr.insert(at, session.state.doc.child(0)))
		counters.invalidate(1)

		expect(markers(editor, counters, 251, 253)).toEqual(["252.", "253."])
		expect(markers(editor, counters, 0, 2)).toEqual(["1.", "2."])
	})
})

describe("reflow numbering in a long table", () => {
	const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${numbered(text)}</w:tc>`
	const ROWS = 3000
	const TABLE = buildDocx({
		body:
			numbered("Before") +
			`<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>${Array.from({ length: ROWS }, (_, k) => `<w:tr>${cell(`Row ${String(k)}`)}</w:tr>`).join("")}</w:tbl>` +
			numbered("After"),
		parts: [
			NUMBERING_PART(
				'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
					'<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
			)
		],
		relationships: [{ id: "rIdN", type: "numbering", target: "numbering.xml" }]
	})
	// Row `row`'s position range in the table at block 1.
	const rowRange = (editor: PagedEditor, row: number): [number, number] => {
		const doc = editor.body.session.state.doc
		const table = doc.child(1)
		let at = doc.child(0).nodeSize + 1

		for (let r = 0; r < row; r++) at += table.child(r).nodeSize

		return [at, at + table.child(row).nodeSize]
	}
	// The markers of the rows `rows` asked for and of the paragraph after the table, counted by `counters`.
	const counted = (editor: PagedEditor, counters: StoryCounters, rows: readonly number[]): string[] => {
		const doc = editor.body.session.state.doc
		const ranges = rows.map(row => rowRange(editor, row))
		const out: string[] = []

		counters.count(
			editor.body.session,
			doc,
			1,
			3,
			index => editor.body.edits.starts[index] ?? doc.content.size,
			(_pos, text) => out.push(text),
			() => undefined,
			(from, to) => ranges.some(([start, end]) => start < to && end > from)
		)

		return out
	}

	it("counts again from the row edited, only as far as its numbers changed, the same as counting anew", async () => {
		const { editor } = await pagedEditor(TABLE)
		const session = editor.body.session
		const counters = new StoryCounters(editor, session)

		expect(counted(editor, counters, [10, ROWS - 1])).toEqual(["12.", `${String(ROWS + 1)}.`, `${String(ROWS + 2)}.`])

		// Text typed in row 10: its numbers are as they were, the rows after it are not read again.
		const paragraph = vi.spyOn(session.formats, "paragraph")
		const [start] = rowRange(editor, 10)

		session.dispatch(session.state.tr.insertText("x", start + 3))
		counters.invalidate(1)
		paragraph.mockClear()

		expect(counted(editor, counters, [10, ROWS - 1])).toEqual(["12.", `${String(ROWS + 1)}.`, `${String(ROWS + 2)}.`])
		expect(paragraph.mock.calls.length).toBeLessThan(100)

		// A numbered row inserted at row 10: the rows after it count one more, as counted anew.
		session.dispatch(session.state.tr.insert(start, session.state.doc.child(1).child(10)))
		counters.invalidate(1)

		const again = counted(editor, counters, [9, 11, 2000, ROWS])

		expect(again).toEqual(counted(editor, new StoryCounters(editor, session), [9, 11, 2000, ROWS]))
		expect(again).toEqual(["11.", "13.", "2002.", `${String(ROWS + 2)}.`, `${String(ROWS + 3)}.`])

		// Rows not asked for and unchanged since: none of them read.
		paragraph.mockClear()
		expect(counted(editor, counters, [ROWS])).toEqual([`${String(ROWS + 2)}.`, `${String(ROWS + 3)}.`])
		expect(paragraph.mock.calls.length).toBeLessThan(40)
		paragraph.mockRestore()
	})
})

// What a copy writes before each paragraph (list markers) in Mobile view, and what the pages show there.
function copies(editor: PagedEditor): { reflow: string[]; pages: string[] } {
	const session = editor.body.session
	const doc = session.state.doc
	const story = editor.body.edits
	const texts = new Map<number, string>()

	new StoryCounters(editor, session).count(
		session,
		doc,
		0,
		doc.childCount,
		index => story.starts[index] ?? doc.content.size,
		(pos, text, paragraph, suffix) => texts.set(pos, markerCopy(session, paragraph, text, suffix)),
		() => undefined
	)

	const reflow: string[] = []
	const pages: string[] = []

	doc.forEach((_node, offset) => {
		reflow.push(texts.get(offset + 1) ?? "")
		pages.push(editor.geometry.markerText(offset + 1))
	})

	return { reflow, pages }
}

describe("reflow numbering as the pages count", () => {
	const list = (numId: number, text: string, mark = ""): string =>
		`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${String(numId)}"/></w:numPr>${mark}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
	const DELETED_MARK = '<w:rPr><w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr>'
	const NUMBERED_PARTS = [
		NUMBERING_PART(
			'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/><w:rPr><w:vanish/></w:rPr></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:suff w:val="space"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:suff w:val="nothing"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>' +
				'<w:num w:numId="5"><w:abstractNumId w:val="4"/></w:num><w:num w:numId="6"><w:abstractNumId w:val="5"/></w:num>' +
				'<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>'
		)
	]
	const NUMBERED = buildDocx({
		body:
			list(2, "One", DELETED_MARK) +
			list(2, "Two") +
			list(2, "Three") +
			list(3, "Hidden marker") +
			list(2, "Four") +
			list(4, "Spaced") +
			list(5, "No text, a tab") +
			list(6, "No text, nothing"),
		parts: NUMBERED_PARTS,
		relationships: [{ id: "rIdN", type: "numbering", target: "numbering.xml" }]
	})

	it("joins a paragraph whose mark the view hides to the next, hides a hidden marker, ends with its suffix, also one of no text", async () => {
		const { editor } = await pagedEditor(NUMBERED)

		for (const view of [RevisionView.Final, RevisionView.Markup]) {
			editor.setView(view)
			await settleAll(editor)

			const { reflow, pages } = copies(editor)

			expect(reflow).toEqual(pages)
		}

		editor.setView(RevisionView.Final)
		await settleAll(editor)

		// One and Two are one paragraph in the Final view (the mark between them is deleted): one marker.
		expect(copies(editor).reflow).toEqual(["1.\t", "", "2.\t", "", "3.\t", "1. ", "\t", ""])
	})

	it("counts nothing in a vertically merged cell's continuation, as the pages lay none of it out", async () => {
		const cell = (merge: string, text: string): string =>
			`<w:tc><w:tcPr><w:vMerge${merge === "" ? "" : ` w:val="${merge}"`}/></w:tcPr>${list(2, text)}</w:tc>`
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					list(2, "Before") +
					'<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>' +
					`<w:tr>${cell("restart", "Merged")}</w:tr><w:tr>${cell("", "Continued")}</w:tr></w:tbl>` +
					list(2, "After"),
				parts: NUMBERED_PARTS,
				relationships: [{ id: "rIdN", type: "numbering", target: "numbering.xml" }]
			})
		)
		const session = editor.body.session
		const doc = session.state.doc
		const texts: string[] = []

		new StoryCounters(editor, session).count(
			session,
			doc,
			0,
			doc.childCount,
			index => editor.body.edits.starts[index] ?? doc.content.size,
			(_pos, text) => texts.push(text),
			() => undefined
		)

		expect(texts).toEqual(["1.", "2.", "3."])
		expect(editor.geometry.markerText((editor.body.edits.starts[2] ?? 0) + 1)).toBe("3.\t")
	})

	it("numbers notes by their section's properties, restarting with each section where those say", async () => {
		const SEPARATORS =
			'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
			'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
		const reference = (id: number): string =>
			`<w:p><w:r><w:t>Text ${String(id)}</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${String(id)}"/></w:r></w:p>`
		const section = (footnotePr: string): string =>
			`<w:p><w:pPr><w:sectPr>${footnotePr}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:pPr></w:p>`
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					reference(1) +
					reference(2) +
					section("") +
					reference(3) +
					section('<w:footnotePr><w:numFmt w:val="lowerLetter"/></w:footnotePr>') +
					reference(4),
				settings: '<w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr>',
				footnotes:
					SEPARATORS +
					[1, 2, 3, 4]
						.map(id => `<w:footnote w:id="${String(id)}"><w:p><w:r><w:t>Note ${String(id)}</w:t></w:r></w:p></w:footnote>`)
						.join("")
			})
		)
		const session = editor.body.session
		const doc = session.state.doc
		const marks: string[] = []

		new StoryCounters(editor, session).count(
			session,
			doc,
			0,
			doc.childCount,
			index => editor.body.edits.starts[index] ?? doc.content.size,
			() => undefined,
			(_pos, text) => marks.push(text)
		)

		// Restarting with each section; the second section's own format.
		expect(marks).toEqual(["1", "2", "a", "1"])
	})
})

describe("reflow stylesheet", () => {
	it("keeps what a block holds inside its measured height", () => {
		const css = readFileSync(join(import.meta.dirname, "..", "css", "docx-reflow.css"), "utf8")
		const rule = (selector: string): string => new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? ""

		expect(rule(".fo-docx-reflow-p")).toContain("display: flow-root")
		expect(rule(".fo-docx-reflow-table")).not.toMatch(/\bmargin:/)
	})

	it("hides tracked rows and cells by token, in the revision views that do not have them (one both is in neither)", () => {
		const css = readFileSync(join(import.meta.dirname, "..", "css", "docx-reflow.css"), "utf8")
		const hiding = (/([^{}]*data-fo-revision[^{}]*)\{\s*display: none;/.exec(css)?.[1] ?? "")
			.split(",")
			.map(selector => selector.trim())

		for (const element of ["tr", "td"]) {
			expect(hiding).toContain(`.fo-docx-reflow[data-fo-revisions="final"] ${element}[data-fo-revision~="del"]`)
			expect(hiding).toContain(`.fo-docx-reflow[data-fo-revisions="original"] ${element}[data-fo-revision~="ins"]`)
		}
	})
})

describe("reflow run CSS", () => {
	it("names a face the document learned after the run's CSS was first made", async () => {
		const session = await sessionOf({
			body: '<w:p><w:r><w:rPr><w:rFonts w:ascii="Foo" w:hAnsi="Foo"/><w:b/></w:rPr><w:t>text</w:t></w:r></w:p>'
		})
		const paragraph = session.state.doc.child(0)
		const run = session.formats.resolvedRun(session.formats.paragraph(paragraph), paragraph.child(0).marks)
		const known = new Map<string, string>()
		// One function per view whose answers change, as LayoutFaces' after refresh().
		const faces = (name: string): string | undefined => known.get(name)
		const before = runCss(run, faces)

		expect(before).toMatch(/^font-family: "Foo", /)
		expect(runCss(run, faces)).toBe(before)

		known.set("Foo", '"fo-face-1"')

		const after = runCss(run, faces)

		expect(after).toMatch(/^font-family: "fo-face-1", /)
		expect(after).toContain("font-weight: 700")
		expect(runCss(run)).toBe(before)
	})
})
