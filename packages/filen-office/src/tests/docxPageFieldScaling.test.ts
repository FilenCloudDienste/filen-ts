import type { DocumentLayout } from "@filen/office/core/docx"
import { DECORATION_FLOATS, DECORATION_INTS, FRAGMENT_FLOATS, FRAGMENT_INTS, LINE_FLOATS, LINE_INTS } from "@filen/office/core/text"
import { describe, expect, it } from "vitest"
import { buildDocx } from "./docxSynthetic"
import { layOut } from "./layoutFixtures"
import { cpuMs } from "./timing"

// A paragraph continuing over many pages shows each page's number in its PAGE fields: laid out in time linear in
// its fields, and exactly as building the paragraph again on every page lays it out.

const char = (type: string): string => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
const instr = (text: string): string => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`
const run = (text: string): string => (text === "" ? "" : `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`)
const field = (code: string): string => `${char("begin")}${instr(code)}${char("separate")}${run("1")}${char("end")}`
const simple = (code: string): string => `<w:fldSimple w:instr="${code}">${run("1")}</w:fldSimple>`

// `count` fields after `text` each (every seventh a w:fldSimple), the first with `first` for its code; `section`
// closes the body.
function paragraph(text: string, count: number, code: string, first = code, section = ""): string {
	let body = "<w:p>"

	for (let k = 0; k < count; k++) body += run(text) + (k % 7 === 3 ? simple : field)(k === 0 ? first : code)

	return `${body}</w:p>${section}`
}

async function layoutMs(body: string): Promise<number> {
	let least = Infinity

	for (let round = 0; round < 2; round++) {
		const bytes = buildDocx({ body })
		const start = cpuMs()

		await layOut(bytes)
		least = Math.min(least, cpuMs() - start)
	}

	return least
}

// Every page's lines, fragments, decorations, sources with their texts and maps, exactly.
function pagesOf(layout: DocumentLayout): unknown[] {
	return layout.pages.map(page => {
		const text = page.text

		return {
			number: page.number,
			lines: Array.from(text.lineFloats.subarray(0, text.lineCount * LINE_FLOATS)),
			lineInts: Array.from(text.lineInts.subarray(0, text.lineCount * LINE_INTS)),
			fragments: Array.from(text.fragmentFloats.subarray(0, text.fragmentCount * FRAGMENT_FLOATS)),
			fragmentInts: Array.from(text.fragmentInts.subarray(0, text.fragmentCount * FRAGMENT_INTS)),
			decorations: Array.from(text.decorationFloats.subarray(0, text.decorationCount * DECORATION_FLOATS)),
			decorationInts: Array.from(text.decorationInts.subarray(0, text.decorationCount * DECORATION_INTS)),
			sources: page.sourceTexts.slice(0, page.sourceCount),
			sourceInts: Array.from(page.sourceInts.subarray(0, page.sourceCount * 4)),
			map: Array.from(page.sourceMapPool.subarray(0, page.sourceMapRanges[page.sourceCount * 2 - 1] ?? 0))
		}
	})
}

// Laid out, and laid out again from pages inside the paragraph (continuing from a page's snapshot).
async function expectSame(reused: string, rebuilt: string, minPages: number): Promise<void> {
	for (const recordMaps of [false, true]) {
		const a = await layOut(buildDocx({ body: reused }), { recordMaps })
		const b = await layOut(buildDocx({ body: rebuilt }), { recordMaps })
		const expected = pagesOf(b)

		expect(a.pages.length).toBeGreaterThanOrEqual(minPages)
		expect(pagesOf(a)).toEqual(expected)

		for (const page of [1, 9, Math.floor(a.pages.length / 2), a.pages.length - 2]) {
			await a.relayoutFrom(page)

			expect(pagesOf(a)).toEqual(expected)
		}
	}
}

// A small page: many pages from little text.
const PAGE =
	'<w:pgSz w:w="4000" w:h="4000"/><w:pgMar w:top="300" w:bottom="300" w:left="300" w:right="300" w:header="0" w:footer="0" w:gutter="0"/>'
const WORDS =
	" lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat "

describe("PAGE fields in a paragraph over many pages", () => {
	it("lay out in time linear in their number", { timeout: 600_000 }, async () => {
		const small = await layoutMs(paragraph("a ", 20_000, " PAGE "))
		const large = await layoutMs(paragraph("a ", 80_000, " PAGE "))
		const stored = await layoutMs(paragraph("a ", 80_000, " REF x "))

		// Building the paragraph again on every page made four times the fields cost about sixteen times as much.
		expect(large).toBeLessThan(small * 6)
		expect(large).toBeLessThan(stored * 2)
	})

	// Each oracle writes one field's format as an explicit switch where the others take the same format from the
	// section: a paragraph whose fields differ so is built again on every page.
	it("break lines as building the paragraph again does while page numbers grow to three digits", { timeout: 600_000 }, async () => {
		await expectSame(
			paragraph(WORDS, 400, " PAGE ", " PAGE ", `<w:sectPr>${PAGE}</w:sectPr>`),
			paragraph(WORDS, 400, " PAGE ", " PAGE \\* Arabic ", `<w:sectPr>${PAGE}</w:sectPr>`),
			101
		)
	})

	it("break lines as building the paragraph again does in a table cell", { timeout: 600_000 }, async () => {
		const cell = (body: string): string =>
			`<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${body}</w:tc></w:tr></w:tbl><w:p/><w:sectPr>${PAGE}</w:sectPr>`

		await expectSame(cell(paragraph(WORDS, 150, " PAGE ")), cell(paragraph(WORDS, 150, " PAGE ", " PAGE \\* Arabic ")), 30)
	})

	it("break lines as building the paragraph again does with roman and letter page numbers", { timeout: 600_000 }, async () => {
		const switches: Readonly<Record<string, string>> = {
			lowerRoman: "roman",
			upperRoman: "ROMAN",
			lowerLetter: "alphabetic",
			upperLetter: "ALPHABETIC"
		}

		for (const [format, name] of Object.entries(switches)) {
			const section = `<w:sectPr>${PAGE}<w:pgNumType w:fmt="${format}"/></w:sectPr>`

			await expectSame(
				paragraph(WORDS, 150, " PAGE ", " PAGE ", section),
				paragraph(WORDS, 150, " PAGE ", ` PAGE \\* ${name} `, section),
				30
			)
		}
	})

	it("break lines as building the paragraph again does when lines break inside page numbers", { timeout: 600_000 }, async () => {
		const section =
			'<w:sectPr><w:pgSz w:w="600" w:h="2400"/><w:pgMar w:top="200" w:bottom="200" w:left="200" w:right="200" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'

		await expectSame(
			paragraph("", 1_500, " PAGE ", " PAGE ", section),
			paragraph("", 1_500, " PAGE ", " PAGE \\* Arabic ", section),
			101
		)
	})

	it(
		"break lines as building the paragraph again does with page numbers in words in another language",
		{ timeout: 600_000 },
		async () => {
			const rPr = (lang: string): string => `<w:rPr><w:lang w:val="${lang}"/></w:rPr>`
			const germanField = (code: string): string =>
				`<w:r>${rPr("de-DE")}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr("de-DE")}<w:instrText xml:space="preserve">${code}</w:instrText></w:r>` +
				`<w:r>${rPr("de-DE")}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr("de-DE")}<w:t>1</w:t></w:r><w:r>${rPr("de-DE")}<w:fldChar w:fldCharType="end"/></w:r>`
			// The oracle's first field writes the same digits with another switch: the fields differ, so it is built again on every page.
			const body = (first: string): string => {
				let text = "<w:p>"

				for (let k = 0; k < 150; k++) text += run(WORDS) + germanField(k === 0 ? first : " PAGE \\* OrdText ")

				return `${text}</w:p><w:sectPr>${PAGE}</w:sectPr>`
			}

			await expectSame(body(" PAGE \\* OrdText "), body(" PAGE \\* Arabic "), 30)

			const layout = await layOut(buildDocx({ body: body(" PAGE \\* OrdText ") }))

			// Not English words: the number (formatNumber's fallback outside English).
			expect(layout.pages.some(page => page.sourceTexts.slice(0, page.sourceCount).some(text => /first|second/.test(text)))).toBe(
				false
			)
		}
	)
})
