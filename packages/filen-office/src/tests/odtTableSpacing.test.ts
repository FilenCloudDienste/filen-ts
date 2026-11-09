import { describe, expect, it } from "vitest"
import { TextSelection } from "prosemirror-state"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { decodeUtf8 } from "@filen/office/core/xml"
import { pageLines } from "./layoutFixtures"
import { odtBytes, odtLayout, partText, translated, type OdtParts } from "./odtFixtures"
import { editOdt, odtEditsOf } from "./odtWriteFixtures"
import { translateOdt } from "../core/odt/translate"
import { writeOdt } from "../core/odt/write/writer"
import { splitParagraph } from "../core/docx/paged/index"

// A table's space above and below (style:table-properties fo:margin-top/bottom): LibreOffice adds it to the space of
// the paragraph beside it (measured with LibreOffice 25.8's PDF export: paragraph 20 pt below and table 50 pt above
// leave 70 pt; table 30 pt below and paragraph 70 pt above leave 100 pt).

const STYLES =
	'<style:default-style style:family="paragraph"><style:text-properties fo:font-family="&apos;Liberation Sans&apos;" fo:font-size="10pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph"/>'
const AUTOMATIC =
	'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="20pt"/></style:style><style:style style:name="P2" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="70pt" fo:margin-bottom="0pt"/></style:style><style:style style:name="T1" style:family="table"><style:table-properties style:width="10cm" table:align="left" fo:margin-top="50pt" fo:margin-bottom="30pt"/></style:style>'
const TABLE =
	'<table:table table:name="T" table:style-name="T1"><table:table-column/><table:table-row><table:table-cell><text:p>Beta</text:p></table:table-cell></table:table-row></table:table>'
const PARTS: OdtParts = {
	styles: STYLES,
	automatic: AUTOMATIC,
	body: `<text:p text:style-name="P1">Alpha</text:p>${TABLE}<text:p text:style-name="P2">Gamma</text:p>`
}

function bodyBlocks(xml: string): string[] {
	const body = /<w:body>([\s\S]*)<\/w:body>/u.exec(xml)?.[1] ?? ""

	return [...body.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p\/>|<w:tbl>[\s\S]*?<\/w:tbl>/gu)].map(match => match[0])
}

function spacing(block: string | undefined): string | undefined {
	const pPr = /^<w:p><w:pPr>([\s\S]*?)<\/w:pPr>/u.exec(block ?? "")?.[1] ?? ""

	return /<w:spacing\b[^>]*\/>/u.exec(pPr.replace(/<w:rPr>[\s\S]*<\/w:rPr>/u, ""))?.[0]
}

async function content(bytes: Uint8Array): Promise<string> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const entry = archive.get("content.xml")

	if (entry === undefined) throw new Error("content.xml")

	return decodeUtf8(await archive.read(entry))
}

type Editing = Awaited<ReturnType<typeof editOdt>>

function paragraphAt(e: Editing, index: number): number {
	let found = -1
	let k = 0

	e.session.state.doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.type.name === "paragraph") {
			if (k++ === index) found = pos

			return false
		}

		return node.type.name !== "table"
	})

	if (found < 0) throw new Error(`no paragraph ${index}`)

	return found
}

function select(e: Editing, from: number, to = from): void {
	e.session.dispatch(e.session.state.tr.setSelection(TextSelection.create(e.session.state.doc, from, to)))
}

async function save(bytes: Uint8Array, edit: (e: Editing) => Promise<void> | void): Promise<Uint8Array> {
	const e = await editOdt(bytes)

	await edit(e)

	return (await writeOdt(e.source, await odtEditsOf(e))).bytes
}

async function documentOf(bytes: Uint8Array): Promise<string> {
	const result = await translateOdt(bytesSource(bytes))

	if (!result.ok) throw new Error(result.message)

	return partText(result.translation, "word/document.xml")
}

describe("an ODT table's space above and below", () => {
	it("is added to the paragraphs beside it", async () => {
		const translation = await translated(PARTS)
		const blocks = bodyBlocks(partText(translation, "word/document.xml"))

		// 20 pt + 50 pt above the table, 30 pt + 70 pt below it.
		expect(spacing(blocks[0])).toBe('<w:spacing w:before="0" w:after="1400"/>')
		expect(blocks[1]?.startsWith("<w:tbl>")).toBe(true)
		expect(spacing(blocks[2])).toBe('<w:spacing w:before="2000" w:after="0"/>')
		expect(translation.tableSpacing?.get(1)).toEqual({ top: 1000, bottom: 600 })
		expect(translation.lossy.has("tableSpacing")).toBe(false)
	})

	it("adds to the space a paragraph's style gives it, both sides then its own", async () => {
		const xml = partText(
			await translated({
				styles: `${STYLES}<style:style style:name="Spaced" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="6pt" fo:margin-bottom="12pt"/></style:style>`,
				automatic: AUTOMATIC,
				body: `<text:p text:style-name="Spaced">Alpha</text:p>${TABLE}<text:p text:style-name="Spaced">Gamma</text:p>`
			}),
			"word/document.xml"
		)
		const blocks = bodyBlocks(xml)

		expect(blocks[0]).toContain('<w:pStyle w:val="Spaced"/>')
		expect(spacing(blocks[0])).toBe('<w:spacing w:before="120" w:after="1240"/>')
		expect(spacing(blocks[2])).toBe('<w:spacing w:before="720" w:after="240"/>')
	})

	it("keeps a paragraph's line spacing beside the space it adds", async () => {
		const xml = partText(
			await translated({
				styles: STYLES,
				automatic: `${AUTOMATIC}<style:style style:name="L" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:line-height="150%"/></style:style>`,
				body: `${TABLE}<text:p text:style-name="L">Gamma</text:p>`
			}),
			"word/document.xml"
		)

		expect(spacing(bodyBlocks(xml)[1])).toBe('<w:spacing w:before="600" w:after="0" w:line="360" w:lineRule="auto"/>')
	})

	it("is flagged where no paragraph is beside the table", async () => {
		const first = await translated({ styles: STYLES, automatic: AUTOMATIC, body: `${TABLE}<text:p>after</text:p>` })

		expect(first.lossy.get("tableSpacing")).toBe(1)

		const last = await translated({ styles: STYLES, automatic: AUTOMATIC, body: `<text:p>before</text:p>${TABLE}` })

		expect(last.lossy.get("tableSpacing")).toBe(1)

		const nested = await translated({
			styles: STYLES,
			automatic: AUTOMATIC,
			body: `<table:table><table:table-column/><table:table-row><table:table-cell><text:p>x</text:p>${TABLE}<text:p>y</text:p></table:table-cell></table:table-row></table:table>`
		})

		expect(nested.lossy.get("tableSpacing")).toBe(1)
		expect(nested.tableSpacing).toBeUndefined()
	})

	it("goes to the paragraph after the table even when that paragraph holds a table of its own", async () => {
		const xml = partText(
			await translated({
				styles: STYLES,
				automatic: AUTOMATIC,
				body: `<text:p text:style-name="P1">Alpha</text:p>${TABLE}<text:p text:style-name="P2"><draw:frame text:anchor-type="as-char" svg:width="3cm" svg:height="2cm"><draw:text-box>${TABLE.replace('table:name="T"', 'table:name="U"')}</draw:text-box></draw:frame>Gamma</text:p>`
			}),
			"word/document.xml"
		)

		expect(spacing(bodyBlocks(xml)[2])).toBe('<w:spacing w:before="2000" w:after="0"/>')
	})

	it("leaves the paragraph a section ends with, and the one starting the next after a table, without it", async () => {
		const parts: OdtParts = {
			styles: STYLES,
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Other" style:page-layout-name="pm1"/>',
			automatic: `${AUTOMATIC}<style:style style:name="PB" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Other"><style:paragraph-properties fo:margin-top="5pt" fo:margin-bottom="0pt"/></style:style><style:style style:name="TB" style:family="table" style:master-page-name="Standard"><style:table-properties style:width="10cm" table:align="left" fo:margin-top="50pt" fo:margin-bottom="30pt"/></style:style>`,
			body: `<text:p text:style-name="P1">Alpha</text:p>${TABLE}<text:p text:style-name="PB">Gamma</text:p>${TABLE.replace('"T1"', '"TB"')}<text:p>end</text:p>`
		}
		const translation = await translated(parts)
		const blocks = bodyBlocks(partText(translation, "word/document.xml"))

		expect(spacing(blocks[0])).toBe('<w:spacing w:before="0" w:after="1400"/>')
		// The table ends the first section: an empty paragraph carries it, and Gamma starts the next one.
		expect(blocks[2]).toMatch(/^<w:p><w:pPr><w:sectPr>/u)
		expect(spacing(blocks[3])).toBe('<w:spacing w:before="100" w:after="0"/>')

		// Gate 1 locks the carrier and the paragraph starting the section after a table, spaced or not: Alpha and end
		// stay editable.
		const e = await editOdt(odtBytes(parts))

		for (const index of [0, 1]) {
			select(e, paragraphAt(e, index) + 2)
			await e.editor.execute({ type: "align.center" })
		}

		const written = (await writeOdt(e.source, await odtEditsOf(e))).bytes

		expect(bodyBlocks(await documentOf(written)).map(spacing)).toEqual(blocks.map(spacing))
	})

	it("leaves a table without space and its paragraphs as they were", async () => {
		const xml = partText(
			await translated({
				styles: STYLES,
				automatic: AUTOMATIC,
				body: '<text:p text:style-name="P1">Alpha</text:p><table:table><table:table-column/><table:table-row><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>'
			}),
			"word/document.xml"
		)

		expect(spacing(bodyBlocks(xml)[0])).toBe('<w:spacing w:before="0" w:after="400"/>')
	})

	it("lays out as LibreOffice does", async () => {
		const { layout } = await odtLayout(odtBytes(PARTS))
		const page = layout.pages[0]
		const tops = pageLines(layout, 0).map((_, index) => (page?.text.lineFloats[index * 5 + 2] ?? 0) * 15)

		// Baselines of Alpha, Beta (in the table) and Gamma: one line (10 pt font) plus 70 pt, then plus 100 pt.
		const pitches = tops.slice(1).map((value, index) => Math.round(value - (tops[index] ?? 0)))

		expect(pitches.length).toBe(2)
		expect(Math.abs((pitches[0] ?? 0) - (pitches[1] ?? 0) + 600)).toBeLessThanOrEqual(2)
	})
})

describe("an ODT table's space above and below on save", () => {
	it("round-trips unedited byte for byte", async () => {
		const bytes = odtBytes(PARTS)
		const before = await content(bytes)
		const written = await save(bytes, () => undefined)

		expect(await content(written)).toBe(before)
	})

	it("an alignment change beside the table does not write the table's space into the paragraph", async () => {
		const bytes = odtBytes({
			styles: `${STYLES}<style:style style:name="Spaced" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="6pt" fo:margin-bottom="12pt"/></style:style>`,
			automatic: AUTOMATIC,
			body: `<text:p text:style-name="Spaced">Alpha</text:p>${TABLE}<text:p text:style-name="Spaced">Gamma</text:p>`
		})
		const written = await save(bytes, async e => {
			select(e, paragraphAt(e, 0) + 2)
			await e.editor.execute({ type: "align.center" })
			select(e, paragraphAt(e, 1) + 2)
			await e.editor.execute({ type: "align.center" })
		})
		const xml = await content(written)

		expect(xml).not.toMatch(/fo:margin-(?:top|bottom)="(?:62|36)pt"/u)
		// Read again, the paragraphs show what the edit showed: their style's space plus the table's.
		const blocks = bodyBlocks(await documentOf(written))

		expect(spacing(blocks[0])).toBe('<w:spacing w:before="120" w:after="1240"/>')
		expect(spacing(blocks[2])).toBe('<w:spacing w:before="720" w:after="240"/>')
		expect(xml).toContain('table:style-name="T1"')
		expect(xml).toContain("fo:text-align")
	})

	it("is opened with nothing locked, and typing beside the table keeps the paragraphs' styles", async () => {
		const bytes = odtBytes(PARTS)
		const e = await editOdt(bytes)

		expect(e.locked).toBe(0)

		e.session.dispatch(e.session.state.tr.insertText("New ", paragraphAt(e, 0) + 1))
		e.session.dispatch(e.session.state.tr.insertText("New ", paragraphAt(e, 1) + 1))

		const xml = await content((await writeOdt(e.source, await odtEditsOf(e))).bytes)

		expect(xml).toContain('<text:p text:style-name="P1">New Alpha</text:p>')
		expect(xml).toContain('<text:p text:style-name="P2">New Gamma</text:p>')
		expect(xml).not.toMatch(/<style:style style:name="P3"/u)
	})

	it("a space set beside the table is written less the table's", async () => {
		const written = await save(odtBytes(PARTS), async e => {
			select(e, paragraphAt(e, 1) + 2)
			// 40 pt above as the edit shows it: 30 pt of it the table's.
			await e.editor.execute({ type: "paragraph.spacing", before: 800 })
		})
		const xml = await content(written)
		const style = /<text:p text:style-name="([^"]+)">Gamma<\/text:p>/u.exec(xml)?.[1]

		expect(style).toBeDefined()
		expect(
			new RegExp(`<style:style style:name="${style}"[^>]*>\\s*<style:paragraph-properties[^>]*fo:margin-top="10pt"`, "u").test(xml)
		).toBe(true)
		expect(spacing(bodyBlocks(await documentOf(written))[2])).toContain('w:before="800"')
	})

	it("deleting the paragraph beside the table writes the table with the space the edit shows", async () => {
		const bytes = odtBytes({
			...PARTS,
			body: `<text:p text:style-name="P1">Alpha</text:p>${TABLE}<text:p text:style-name="P2">Gamma</text:p><text:p>Delta</text:p>`
		})
		const written = await save(bytes, e => {
			const at = paragraphAt(e, 1)
			const node = e.session.state.doc.nodeAt(at)

			if (node === null) throw new Error("no paragraph")

			e.session.dispatch(e.session.state.tr.delete(at, at + node.nodeSize))
		})
		const xml = await content(written)

		// Delta, with no space above, now follows the table: the table keeps no space below.
		expect(xml).not.toContain("Gamma")
		expect(xml).toMatch(
			/<style:table-properties[^>]*fo:margin-top="50pt"[^>]*fo:margin-bottom="0pt"|<style:table-properties[^>]*fo:margin-bottom="0pt"[^>]*fo:margin-top="50pt"/u
		)

		const blocks = bodyBlocks(await documentOf(written))

		expect(spacing(blocks[0])).toBe('<w:spacing w:before="0" w:after="1400"/>')
		expect(blocks[2]).toContain("Delta")
		expect(spacing(blocks[2])).toBeUndefined()
	})

	it("an edit away from the table is proven from the changed paragraph alone, the table kept", async () => {
		const bytes = odtBytes({ ...PARTS, body: `${PARTS.body}<text:p>far</text:p><text:p>away</text:p>` })
		const e = await editOdt(bytes)

		e.session.dispatch(e.session.state.tr.insertText("so ", paragraphAt(e, 3) + 1))

		const written = await writeOdt(e.source, await odtEditsOf(e))
		const xml = await content(written.bytes)

		expect(written.proof).toBe("span")
		expect(xml).toContain(`<text:p text:style-name="P1">Alpha</text:p>${TABLE}<text:p text:style-name="P2">Gamma</text:p>`)
		expect(xml).toContain("<text:p>so away</text:p>")
	})

	it("a paragraph between two tables, or in a list, keeps both tables' space through a change", async () => {
		const list =
			'<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>'
		const bytes = odtBytes({
			styles: STYLES,
			automatic: `${AUTOMATIC}${list}`,
			body: `<text:list text:style-name="L1"><text:list-item><text:p text:style-name="P1">Alpha</text:p></text:list-item></text:list>${TABLE}<text:p>Middle</text:p>${TABLE.replace('table:name="T"', 'table:name="U"')}<text:h text:outline-level="1">End</text:h>`
		})
		const e = await editOdt(bytes)

		expect(e.locked).toBe(0)

		for (const index of [0, 1, 2]) {
			select(e, paragraphAt(e, index) + 2)
			await e.editor.execute({ type: "align.center" })
		}

		const written = (await writeOdt(e.source, await odtEditsOf(e))).bytes
		const blocks = bodyBlocks(await documentOf(written))

		expect(spacing(blocks[0])).toBe('<w:spacing w:before="0" w:after="1400"/>')
		// 30 pt below the first table, 50 pt above the second.
		expect(spacing(blocks[2])).toBe('<w:spacing w:before="600" w:after="1000"/>')
		expect(spacing(blocks[4])).toContain('w:before="600"')
		expect((await content(written)).match(/table:style-name="T1"/gu)?.length).toBe(2)
	})

	it("a paragraph split beside the table saves", async () => {
		const written = await save(odtBytes(PARTS), e => {
			select(e, paragraphAt(e, 1) + 3)

			const split = splitParagraph(e.session.state, e.session.formats)

			if (split !== null) e.session.dispatch(split)
		})
		const xml = await content(written)

		expect(xml).toContain(">Ga</text:p>")
		expect(xml).toContain(">mma</text:p>")
	})
})
