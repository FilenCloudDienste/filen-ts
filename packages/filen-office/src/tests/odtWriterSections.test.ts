import { describe, expect, it } from "vitest"
import { TextSelection } from "prosemirror-state"
import type { DocxEditorCommand } from "@filen/office/core/docx/edit"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { decodeUtf8 } from "@filen/office/core/xml"
import { writeOdt } from "../core/odt/write/writer"
import { paragraphAttributes } from "../core/odt/write/inverse"
import { documentXml, odtBytes, type OdtParts } from "./odtFixtures"
import { editOdt, odtEditsOf, type OdtEditing } from "./odtWriteFixtures"

// Saves of page styles, section breaks and lists the writer once refused or wrote wrongly, each read back by the
// writer's proof (a save that reads otherwise than its edit is refused).

const STYLES =
	'<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph"/>'
const LAYOUT = (name: string, top: string, header = ""): string =>
	`<style:page-layout style:name="${name}"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="${top}" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/>${header}</style:page-layout>`
const HEADER_STYLE =
	'<style:header-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-bottom="0.5cm"/></style:header-style>'
// A first page with a header of its own on a layout of its own, the rest without one (as LibreOffice converts Word's
// title pages).
const TITLED: OdtParts = {
	styles: STYLES,
	stylesAutomatic: `${LAYOUT("pm1", "2cm")}${LAYOUT("pm2", "1.5cm", HEADER_STYLE)}`,
	masters:
		'<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="First_20_Page" style:display-name="First Page" style:page-layout-name="pm2" style:next-style-name="Standard"><style:header><text:p>Title header</text:p></style:header></style:master-page>',
	automatic:
		'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="First_20_Page"/>',
	body: `<text:p text:style-name="P1">Opening</text:p>${["Two", "Three", "Four", "Five"].map(text => `<text:p>${text}</text:p>`).join("")}`
}

type Edit = (e: OdtEditing) => Promise<void> | void

function paragraphAt(e: OdtEditing, index: number): number {
	let found = -1
	let k = 0

	e.session.state.doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.type.name === "paragraph") {
			if (k++ === index) found = pos

			return false
		}

		return true
	})

	if (found < 0) throw new Error(`no paragraph ${index}`)

	return found
}

const caret =
	(index: number, command: DocxEditorCommand): Edit =>
	async e => {
		const at = paragraphAt(e, index) + 2

		e.session.dispatch(e.session.state.tr.setSelection(TextSelection.create(e.session.state.doc, at)))
		await e.editor.execute(command)
	}

async function save(parts: OdtParts, ...edits: Edit[]): Promise<{ content: string; styles: string }> {
	const e = await editOdt(odtBytes(parts))

	for (const edit of edits) await edit(e)

	const bytes = (await writeOdt(e.source, await odtEditsOf(e))).bytes
	const archive = await ZipArchive.open(bytesSource(bytes))
	const read = async (name: string): Promise<string> => {
		const entry = archive.get(name)

		if (entry === undefined) throw new Error(name)

		return decodeUtf8(await archive.read(entry))
	}

	return { content: await read("content.xml"), styles: await read("styles.xml") }
}

const PAGE = caret(1, { type: "page.setup", orientation: "landscape", margins: { left: 1080 } } as DocxEditorCommand)
const BREAK = caret(3, { type: "insert.sectionBreak", kind: "nextPage" } as DocxEditorCommand)

describe("ODT writer: page styles and sections", () => {
	it("reads a header only the first page shows where the first page's layout puts it", async () => {
		const xml = await documentXml(TITLED)

		// pm2's top margin (1.5 cm), not pm1's: the header the title page shows starts there.
		expect(xml).toMatch(/<w:pgMar [^>]*w:header="850"/u)
	})

	it("sets up a section with a first page of its own on both its layouts", async () => {
		const { styles } = await save(TITLED, PAGE)

		expect(styles).toMatch(
			/<style:page-layout style:name="pm1"><style:page-layout-properties [^>]*style:print-orientation="landscape"/u
		)
		expect(styles).toMatch(
			/<style:page-layout style:name="pm2"><style:page-layout-properties [^>]*style:print-orientation="landscape"/u
		)
	})

	it("sets up a section split off by a new break apart from the rest, on copies of its pages", async () => {
		const { content, styles } = await save(TITLED, BREAK, PAGE)

		const opening = /<text:p text:style-name="([^"]+)">Opening/u.exec(content)?.[1]
		const master = new RegExp(`<style:style style:name="${opening}"[^>]*style:master-page-name="([^"]+)"`, "u").exec(content)?.[1]
		const layout = new RegExp(`<style:master-page style:name="${master}" style:page-layout-name="([^"]+)"`, "u").exec(styles)?.[1]

		// The part before the break on copies set up landscape; the rest still on the source's pages.
		expect(master).not.toBe("First_20_Page")
		expect(styles).toMatch(
			new RegExp(
				`<style:page-layout style:name="${layout}"><style:page-layout-properties [^>]*style:print-orientation="landscape"`,
				"u"
			)
		)
		expect(styles).toMatch(/<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm"/u)
	})

	it("keeps a paragraph's page style when a list takes it in", async () => {
		const { content } = await save(
			{
				...TITLED,
				automatic: `${TITLED.automatic ?? ""}<style:style style:name="P2" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Standard"/>`,
				body: '<text:p text:style-name="P1">Opening</text:p><text:p>Two</text:p><text:p text:style-name="P2">Turns the page</text:p>'
			},
			caret(2, { type: "list.bullet" } as DocxEditorCommand)
		)
		const style = /<text:p text:style-name="([^"]+)">Turns the page/u.exec(content)?.[1]

		expect(content).toMatch(new RegExp(`<style:style style:name="${style}"[^>]*style:master-page-name="Standard"`, "u"))
	})

	it("writes a style name holding a replacement pattern ($1) literally into the start tag it restyles", async () => {
		// The opening paragraph moves to a copy of its page; the source already has a style for that copy, named "P$1".
		const { content } = await save(
			{
				...TITLED,
				automatic: `${TITLED.automatic ?? ""}<style:style style:name="P$1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="First_20_Page_2"/>`
			},
			BREAK,
			PAGE
		)

		expect(/<text:p text:style-name="([^"]+)">Opening/u.exec(content)?.[1]).toBe("P$1")
	})

	it("never gives a paragraph the start tag of one whose style breaks the page", async () => {
		const { content } = await save(
			{
				styles: STYLES,
				automatic:
					'<style:style style:name="Brk" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:break-before="page"/></style:style>',
				body: '<text:p text:style-name="Brk">First</text:p><text:p>Second</text:p>'
			},
			caret(1, { type: "list.bullet" } as DocxEditorCommand)
		)

		expect(content).not.toMatch(/<text:p text:style-name="Brk">Second/u)
	})

	it("reads a space after a picture anchored as a character (Part 3 §6.1.2)", async () => {
		const xml = await documentXml({
			styles: STYLES,
			body: '<text:p>a<draw:frame text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/x.png"/></draw:frame> b</text:p>'
		})

		expect(xml).toContain('<w:t xml:space="preserve"> b</w:t>')
	})

	it("writes left and right alignment as they are, whatever the paragraph's direction", () => {
		const left = paragraphAttributes(
			"jc",
			{ attributes: new Map([["val", "left"]]), children: "" },
			{ tabsRelativeToIndent: true, marginLeft: 0 }
		)

		expect(left?.attributes).toEqual([["fo:text-align", "left"]])
	})

	it("reads a change's date given alone as that day's midnight (a WordprocessingML date and time)", async () => {
		const xml = await documentXml({
			styles: STYLES,
			body: '<text:tracked-changes><text:changed-region xml:id="c1" text:id="c1"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>1970-01-01</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes><text:p><text:change-start text:change-id="c1"/>new<text:change-end text:change-id="c1"/></text:p>'
		})

		expect(xml).toContain('w:date="1970-01-01T00:00:00"')
	})

	it("keeps a header table that follows the page at the widths it shows when the page is set up anew", async () => {
		const { styles } = await save(
			{
				styles: STYLES,
				stylesAutomatic: `${LAYOUT("pm1", "2cm", HEADER_STYLE)}<style:style style:name="HT" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style><style:style style:name="HT.A" style:family="table-column"><style:table-column-properties style:rel-column-width="1*"/></style:style>`,
				masters:
					'<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><table:table table:name="Head" table:style-name="HT"><table:table-column table:style-name="HT.A" table:number-columns-repeated="2"/><table:table-row><table:table-cell office:value-type="string"><text:p>Left</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Right</text:p></table:table-cell></table:table-row></table:table></style:header></style:master-page>',
				body: ["One", "Two", "Three"].map(text => `<text:p>${text}</text:p>`).join("")
			},
			PAGE
		)
		const style = /<table:table table:name="Head" table:style-name="([^"]+)"/u.exec(styles)?.[1]

		expect(style).not.toBe("HT")
		expect(styles).toMatch(
			new RegExp(
				`<style:style style:name="${style}"[^>]*><style:table-properties [^>]*style:width="[\\d.]+pt" table:align="left"`,
				"u"
			)
		)
	})

	it("writes a section break before a right-to-left list item aligned as it was", async () => {
		const LS =
			'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>'
		const { content } = await save(
			{
				styles: STYLES,
				automatic: `${LS}<style:style style:name="R" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="left" style:writing-mode="rl-tb"/></style:style>`,
				body: `<text:list text:style-name="L1">${["אחד", "שתיים", "שלוש", "ארבע"].map(text => `<text:list-item><text:p text:style-name="R">${text}</text:p></text:list-item>`).join("")}</text:list>`
			},
			BREAK
		)

		// The item after the break takes a style of its own (its page style): aligned left, not to its start (right).
		expect(content).toMatch(
			/<style:style [^>]*style:master-page-name="[^"]+"[^>]*><style:paragraph-properties [^>]*fo:text-align="left"/u
		)
		expect(content).not.toContain('fo:text-align="start"')
	})

	it("starts a section's page style at the paragraph a new break before its first one leaves first", async () => {
		const { content } = await save(
			{
				styles: STYLES,
				masters:
					'<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Second" style:page-layout-name="pm1"/>',
				automatic:
					'<style:style style:name="S2" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Second"/>',
				body: '<text:p>One</text:p><text:p/><text:p text:style-name="S2">Three</text:p><text:p>Four</text:p>'
			},
			async e => {
				const at = paragraphAt(e, 1) + 1

				e.session.dispatch(e.session.state.tr.setSelection(TextSelection.create(e.session.state.doc, at)))
				await e.editor.execute({ type: "insert.sectionBreak", kind: "nextPage" } as DocxEditorCommand)
			}
		)
		const masters = [...content.matchAll(/style:master-page-name="([^"]+)"/gu)].map(match => match[1])

		expect(new Set(masters).size).toBeGreaterThanOrEqual(2)
	})
})
