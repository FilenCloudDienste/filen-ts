import { describe, expect, it } from "vitest"
import {
	SECTION_SHIFT,
	SOURCE_INTS,
	SOURCE_MARK_FLOATS,
	SectionMark,
	SourceFlag,
	SourceInt,
	SourceMark,
	type PageDisplayList
} from "@filen/office/core/docx"
import { saveDocx } from "@filen/office/core/docx/write"
import { commandInfo, shortcutFor, shortcutHint } from "../core/docx/edit/index"
import { commandForKey, type KeyLike } from "../core/docx/paged/keys"
import { buildDocx, p } from "./docxSynthetic"
import { layOut, pageLines } from "./layoutFixtures"
import { pagedEditor } from "./pagedFixtures"

// Word's formatting marks (Show/Hide ¶): what layout records for them (cell, row and section ends, the edges breaks
// run to, the paragraph mark's style), hidden text laid out while they show, and Word's keys.

const MARGINS = '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
const TABLE = `<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell("a")}${cell("b")}</w:tr></w:tbl>`

interface SourceView {
	readonly text: string
	readonly flags: number
	readonly start: number
	readonly end: number
	readonly row: number
}

function sources(page: PageDisplayList | undefined): SourceView[] {
	const out: SourceView[] = []

	for (let s = 0; s < (page?.sourceCount ?? 0); s++) {
		const at = s * SOURCE_MARK_FLOATS

		out.push({
			text: page?.sourceTexts[s] ?? "",
			flags: page?.sourceInts[s * SOURCE_INTS + SourceInt.FLAGS] ?? 0,
			start: page?.sourceMarks[at + SourceMark.START] ?? Number.NaN,
			end: page?.sourceMarks[at + SourceMark.END] ?? Number.NaN,
			row: page?.sourceMarks[at + SourceMark.ROW] ?? Number.NaN
		})
	}

	return out
}

function key(key: string, code: string, mods: Partial<Omit<KeyLike, "key" | "code">> = {}): KeyLike {
	return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

describe("formatting marks in the layout", () => {
	it("records cell ends, the row end beside the last cell, and how the next section starts", async () => {
		const body =
			p("first", `<w:sectPr>${MARGINS}</w:sectPr>`) +
			TABLE +
			p("last") +
			`<w:sectPr>${MARGINS}<w:type w:val="continuous"/></w:sectPr>`
		const layout = await layOut(buildDocx({ body }), { recordMaps: true })
		const shown = sources(layout.pages[0])
		const first = shown.find(source => source.text === "first")
		const a = shown.find(source => source.text === "a")
		const b = shown.find(source => source.text === "b")
		const last = shown.find(source => source.text === "last")

		// A paragraph in a page's text column: its edges are the margins (1 in = 96 px).
		expect(first?.start).toBeCloseTo(96, 0)
		expect(first?.end).toBeCloseTo(720, 0)
		expect(((first?.flags ?? 0) & SourceFlag.SECTION_MASK) >> SECTION_SHIFT).toBe(SectionMark.CONTINUOUS)
		expect((last?.flags ?? 0) & SourceFlag.SECTION_MASK).toBe(0)

		expect((a?.flags ?? 0) & (SourceFlag.CELL_END | SourceFlag.ROW_END)).toBe(SourceFlag.CELL_END)
		expect(Number.isNaN(a?.row)).toBe(true)
		expect((b?.flags ?? 0) & (SourceFlag.CELL_END | SourceFlag.ROW_END)).toBe(SourceFlag.CELL_END | SourceFlag.ROW_END)
		// The row ends past the last cell's text, at the cell's own right edge.
		expect(b?.row).toBeGreaterThan(b?.end ?? Infinity)
		expect((last?.flags ?? 0) & SourceFlag.CELL_END).toBe(0)
	})

	it("records nothing for a viewer's layout, which never shows them", async () => {
		const layout = await layOut(buildDocx({ body: p("viewed") + TABLE }))

		expect(layout.pages[0]?.marked).toBe(false)
		expect(layout.pages[0]?.sourceMarks.length).toBe(0)
	})

	it("lays hidden text out only while the marks show it, from the first page, and only when there is any", async () => {
		const hidden = '<w:p><w:r><w:t xml:space="preserve">shown </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r></w:p>'
		const layout = await layOut(buildDocx({ body: hidden }))
		const { editor } = await pagedEditor(buildDocx({ body: hidden }))

		expect(layout.hidden.seen).toBe(true)
		await editor.whenSettled()
		expect(pageLines(editor.layout, 0).map(line => line.text)).toEqual(["shown "])

		let events = 0
		const stop = editor.subscribe(event => {
			if (event.type === "document") events++
		})

		expect(editor.setFormattingMarks(true)).toBe(true)
		expect(editor.formattingMarks).toBe(true)
		expect(editor.setFormattingMarks(true)).toBe(false)
		await editor.whenSettled()
		expect(pageLines(editor.layout, 0).map(line => line.text)).toEqual(["shown secret"])
		expect(events).toBe(1)

		await editor.execute({ type: "view.formattingMarks" })
		await editor.whenSettled()
		expect(editor.formattingMarks).toBe(false)
		expect(pageLines(editor.layout, 0).map(line => line.text)).toEqual(["shown "])
		stop()
		editor.dispose()
	})

	it("changes nothing laid out or saved in a document without hidden text", async () => {
		const bytes = buildDocx({ body: p("plain text") })
		const { editor, pkg, context } = await pagedEditor(bytes)

		await editor.whenSettled()

		const pages = editor.layout.pages

		expect(editor.layout.hidden.seen).toBe(false)
		expect(editor.layout.setShowHidden(true)).toBe(-1)
		expect(editor.layout.pages).toBe(pages)
		expect(editor.layout.setShowHidden(false)).toBe(-1)

		editor.setFormattingMarks(true)
		await editor.whenSettled()
		expect(editor.layout.pages[0]).toBe(pages[0])

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(saved.bytes).toEqual(bytes)
		editor.dispose()
	})
})

describe("Show/Hide ¶ keys", () => {
	it("is Ctrl+Shift+8 off Apple platforms and Cmd+8 on a Mac, as in Word", () => {
		const info = commandInfo("view.formattingMarks")

		if (info === undefined) throw new Error("view.formattingMarks")

		expect(commandForKey(key("*", "Digit8", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "view.formattingMarks" })
		expect(commandForKey(key("8", "Digit8", { metaKey: true }), true)).toEqual({ type: "view.formattingMarks" })
		expect(commandForKey(key("*", "Digit8", { metaKey: true, shiftKey: true }), true)).toBeUndefined()
		expect(commandForKey(key("8", "Digit8", { ctrlKey: true }), false)).toBeUndefined()
		expect(shortcutFor(info, false)).toBe("mod+shift+8")
		expect(shortcutFor(info, true)).toBe("mod+8")
		// Cmd+8 selects a tab in a Mac browser: advertised only in the desktop app.
		expect(shortcutHint(info, true, true)).toBeUndefined()
		expect(shortcutHint(info, true, false)).toBe("mod+8")
		expect(shortcutHint(info, false, true)).toBe("mod+shift+8")
	})
})
