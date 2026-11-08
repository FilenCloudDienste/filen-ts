import { describe, expect, it } from "vitest"
import { TextSelection } from "prosemirror-state"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { decodeUtf8 } from "@filen/office/core/xml"
import type { DocxEditorCommand } from "@filen/office/core/docx/edit"
import { translateOdt } from "../core/odt/index"
import { OdtWriteRefusal, proveOdt, writeOdt } from "../core/odt/write/writer"
import { odtBytes, type OdtParts } from "./odtFixtures"
import { editOdt, odtEditsOf, saveOdt, scriptedOdtEdits } from "./odtWriteFixtures"
import { PNG, paragraphs } from "./rtfWriteFixtures"

// The source-preserving ODT writer: untouched saves are the file itself, edited blocks are rewritten where they
// changed with new automatic styles, the rest copied as it was; what it cannot write it refuses, and Gate 1 locks
// what a rewrite would lose.

async function entry(bytes: Uint8Array, name: string): Promise<string> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const found = archive.get(name)

	if (found === undefined) throw new Error(`no ${name}`)

	return decodeUtf8(await archive.read(found))
}

async function bodyText(bytes: Uint8Array): Promise<string> {
	const read = await translateOdt(bytesSource(bytes))

	if (!read.ok) throw new Error(read.message)

	const xml = decodeUtf8(read.translation.parts.get("word/document.xml") as Uint8Array)

	return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(match => match[1]).join("|")
}

const AUTOMATIC =
	'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>' +
	'<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>'
const STYLES =
	'<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt" style:font-name="Liberation Serif"/></style:default-style>' +
	'<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
	'<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="1"><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>'

function document(body: string, extra: Partial<OdtParts> = {}): Uint8Array {
	return odtBytes({ automatic: AUTOMATIC, styles: STYLES, body, ...extra })
}

function select(editing: Awaited<ReturnType<typeof editOdt>>, from: number, to = from): void {
	editing.session.dispatch(editing.session.state.tr.setSelection(TextSelection.create(editing.session.state.doc, from, to)))
}

describe("ODT writer", () => {
	it("gives an untouched document back byte for byte", async () => {
		const bytes = document(
			'<text:p text:style-name="P1">One</text:p><text:p>Two <text:span text:style-name="T1">three</text:span></text:p>'
		)
		const editing = await editOdt(bytes)
		const written = await writeOdt(editing.source, await odtEditsOf(editing))

		expect(written.bytes).toEqual(bytes)
	})

	it("rewrites only the paragraph typed in, keeping its style", async () => {
		const bytes = document(
			'<text:p text:style-name="P1">One</text:p><text:p>Two <text:span text:style-name="T1">three</text:span></text:p>'
		)
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		editing.session.dispatch(editing.session.state.tr.insertText("Filen ", first.pos + 1))

		const written = await saveOdt(editing)
		const content = await entry(written.bytes, "content.xml")

		expect(content).toContain('<text:p text:style-name="P1">Filen One</text:p>')
		expect(content).toContain('<text:p>Two <text:span text:style-name="T1">three</text:span></text:p>')
		expect(await bodyText(written.bytes)).toBe("Filen One|Two |three")
	})

	it("writes new formatting as a new automatic style named past the ones the file has", async () => {
		const bytes = document('<text:p text:style-name="P1">One two</text:p>', {
			automatic: `${AUTOMATIC}<style:style style:name="T2" style:family="text"/>`
		})
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1, first.pos + 4)
		expect(await editing.editor.execute({ type: "format.bold" })).toBe(true)

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toMatch(
			/<style:style style:name="T3" style:family="text"><style:text-properties[^>]*fo:font-weight="bold"[^>]*\/><\/style:style>/u
		)
		expect(content).toContain('<text:p text:style-name="P1"><text:span text:style-name="T3">One</text:span> two</text:p>')
	})

	it("removes a deleted paragraph's element", async () => {
		const bytes = document("<text:p>One</text:p><text:p>Two</text:p><text:p>Three</text:p>")
		const editing = await editOdt(bytes)
		const second = paragraphs(editing.session.state.doc)[1]

		if (second === undefined) throw new Error("no paragraph")

		editing.session.dispatch(editing.session.state.tr.delete(second.pos, second.pos + second.node.nodeSize))

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toContain("<office:text><text:p>One</text:p><text:p>Three</text:p></office:text>")
	})

	it("inserts a table row with the styles of the row it copies", async () => {
		const table =
			'<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/>' +
			'<table:table-row><table:table-cell table:style-name="C1" office:value-type="string"><text:p>a1x</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>b1x</text:p></table:table-cell></table:table-row>' +
			"</table:table>"
		const bytes = document(`<text:p>Before</text:p>${table}`, {
			automatic: `${AUTOMATIC}<style:style style:name="C1" style:family="table-cell"><style:table-cell-properties fo:background-color="#ffff00" fo:padding="0.1cm"/></style:style>`
		})
		const editing = await editOdt(bytes)

		expect(await scriptedOdtEdits(editing, ["row"])).toEqual(["row"])

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toContain(
			'<table:table-row><table:table-cell table:style-name="C1" office:value-type="string"><text:p/></table:table-cell><table:table-cell office:value-type="string"><text:p/></table:table-cell></table:table-row></table:table>'
		)
	})

	it("turns a paragraph into a bulleted list with a list style of its own", async () => {
		const bytes = document("<text:p>One</text:p><text:p>Two</text:p>")
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1)
		expect(await editing.editor.execute({ type: "list.bullet" })).toBe(true)

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toMatch(
			/<text:list text:style-name="L1"><text:list-item><text:p>One<\/text:p><\/text:list-item><\/text:list><text:p>Two<\/text:p>/u
		)
		expect(content).toMatch(/<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="[^"]+">/u)
	})

	it("adds no Hyperlink style for a new link", async () => {
		const bytes = odtBytes({ body: "<text:p>One</text:p>" })
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1, first.pos + 4)
		expect(await editing.editor.execute({ type: "link.set", target: "https://filen.io/" })).toBe(true)
		expect([...editing.opened.context.newStyles.values()]).toEqual([])

		const written = await saveOdt(editing)

		expect(await entry(written.bytes, "styles.xml")).not.toContain('style:name="Hyperlink"')
		expect(await entry(written.bytes, "content.xml")).toContain('xlink:href="https://filen.io/"')
	})

	it("applies a heading style the document already has", async () => {
		const bytes = document("<text:p>One</text:p><text:p>Two</text:p>")
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1)
		expect(await editing.editor.execute({ type: "style.set", style: "heading1" })).toBe(true)

		const written = await saveOdt(editing)
		const content = await entry(written.bytes, "content.xml")

		// The common style itself: the paragraph had nothing of its own.
		expect(content).toContain('<text:p text:style-name="Heading_20_1">One</text:p>')
		expect(content).not.toContain('<style:style style:name="P2"')
	})

	it("adds a built-in heading style the document lacks to styles.xml", async () => {
		const bytes = odtBytes({ body: "<text:p>One</text:p><text:p>Two</text:p>" })
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1)
		expect(await editing.editor.execute({ type: "style.set", style: "heading1" })).toBe(true)

		const written = await saveOdt(editing)

		expect(await entry(written.bytes, "styles.xml")).toMatch(
			/<style:style style:name="Heading1" style:display-name="Heading 1" style:family="paragraph"[^>]* style:default-outline-level="1">/u
		)
		expect(await entry(written.bytes, "content.xml")).toContain('<text:p text:style-name="Heading1">One</text:p>')
	})

	it("keeps the mimetype entry first and stored, and a template's media type", async () => {
		const bytes = odtBytes({ body: "<text:p>One</text:p>" })
		const template = new Uint8Array(bytes)
		// The fixture's mimetype as a template's (same length, stored): "text" → "text-template" needs a new zip.
		const archive = await ZipArchive.open(bytesSource(template))

		expect(archive.entries[0]?.name).toBe("mimetype")

		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		editing.session.dispatch(editing.session.state.tr.insertText("x", first.pos + 1))

		const written = (await saveOdt(editing)).bytes
		const out = await ZipArchive.open(bytesSource(written))
		const physical = [...out.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)

		expect(physical[0]?.name).toBe("mimetype")
		expect(physical[0]?.method).toBe(0)
		expect(await entry(written, "mimetype")).toBe("application/vnd.oasis.opendocument.text")
	})

	it("copies fields and cross-references as the source has them where the edit left them", async () => {
		const bytes = document(
			'<text:p>Today is <text:date text:date-value="2026-10-23">23 October</text:date>, see <text:span text:style-name="T1"><text:bookmark-ref text:reference-format="text" text:ref-name="here">here</text:bookmark-ref></text:span>.</text:p>' +
				'<text:p><text:bookmark text:name="here"/>Target <text:reference-mark-start text:name="mark"/>marked<text:reference-mark-end text:name="mark"/></text:p>'
		)
		const editing = await editOdt(bytes)

		expect(editing.locked).toBe(0)

		for (const paragraph of paragraphs(editing.session.state.doc).slice(0, 2)) {
			editing.session.dispatch(
				editing.session.state.tr.insertText("Filen ", editing.session.state.doc.resolve(paragraph.pos + 1).pos)
			)
		}

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toContain(
			'<text:p>Filen Today is <text:date text:date-value="2026-10-23">23 October</text:date>, see <text:span text:style-name="T1"><text:bookmark-ref text:reference-format="text" text:ref-name="here">here</text:bookmark-ref></text:span>.</text:p>'
		)
		expect(content).toContain('<text:reference-mark-start text:name="mark"/>marked<text:reference-mark-end text:name="mark"/>')
	})

	it("writes a header's edit into its master page in styles.xml, its page number kept", async () => {
		const bytes = odtBytes({
			body: "<text:p>Body</text:p>",
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>Header <text:page-number text:select-page="current">1</text:page-number> of <text:title>Report</text:title></text:p></style:header></style:master-page>'
		})
		const editing = await editOdt(bytes)
		const name = [...editing.source.translation.parts.keys()].find(part => /^word\/header\d+\.xml$/u.test(part))

		if (name === undefined) throw new Error("no header")

		const header = decodeUtf8(editing.source.translation.parts.get(name) as Uint8Array).replace("Header ", "Edited header ")
		const written = await writeOdt(editing.source, { parts: new Map([[name, new TextEncoder().encode(header)]]) })
		const styles = await entry(written.bytes, "styles.xml")

		expect(styles).toContain(
			'<style:header><text:p>Edited header <text:page-number text:select-page="current">1</text:page-number> of <text:title>Report</text:title></text:p></style:header>'
		)
		expect(await entry(written.bytes, "content.xml")).toBe(await entry(bytes, "content.xml"))
	})

	it("writes a new picture as a frame with an image entry of its own, listed in the manifest", async () => {
		const bytes = odtBytes({ body: "<text:p>One two</text:p><text:p>Three</text:p>" })
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]
		const media = editing.session.context.media.add(PNG)

		if (first === undefined || media === undefined) throw new Error("no paragraph or picture")

		select(editing, first.pos + 4)
		expect(await editing.editor.execute({ type: "image.insert", media, altText: "Three dots" })).toBe(true)

		const written = (await saveOdt(editing)).bytes
		const content = await entry(written, "content.xml")
		const href = /<draw:image xlink:href="(Pictures\/[^"]+\.png)"/u.exec(content)?.[1]

		expect(content).toMatch(
			/<text:p>One<draw:frame draw:style-name="fr1" draw:name="Image1" text:anchor-type="as-char" svg:width="[\d.]+pt" svg:height="[\d.]+pt" draw:z-index="0"><draw:image xlink:href="Pictures\/[^"]+" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"\/><svg:desc>Three dots<\/svg:desc><\/draw:frame> two<\/text:p>/u
		)
		// Its own graphic style: none of the default graphic style's stroke and fill.
		expect(content).toContain(
			'<style:style style:name="fr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>'
		)
		expect(href).toBeDefined()
		expect(await entry(written, "META-INF/manifest.xml")).toContain(`full-path="${href ?? ""}" manifest:media-type="image/png"`)

		const archive = await ZipArchive.open(bytesSource(written))
		const picture = archive.get(href ?? "")

		expect(picture?.method).toBe(0)
		expect(picture === undefined ? undefined : await archive.read(picture)).toEqual(PNG)
	})

	it("records tracked insertions and deletions in text:tracked-changes", async () => {
		const bytes = odtBytes({ body: "<text:p>One two three</text:p><text:p>Last</text:p>" })
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		editing.opened.context.identity.author = "Ann"
		editing.opened.context.review.tracking = true
		editing.session.dispatch(editing.session.state.tr.insertText("new ", first.pos + 5))
		editing.session.dispatch(editing.session.state.tr.delete(first.pos + 13, first.pos + 18))

		const written = (await saveOdt(editing)).bytes
		const content = await entry(written, "content.xml")

		expect(content).toMatch(
			/<office:text><text:tracked-changes text:track-changes="true"><text:changed-region xml:id="ctFilen1" text:id="ctFilen1"><text:insertion><office:change-info><dc:creator>Ann<\/dc:creator><dc:date>[^<]+<\/dc:date><\/office:change-info><\/text:insertion><\/text:changed-region><text:changed-region xml:id="ctFilen2" text:id="ctFilen2"><text:deletion><office:change-info><dc:creator>Ann<\/dc:creator><dc:date>[^<]+<\/dc:date><\/office:change-info><text:p>three<\/text:p><\/text:deletion><\/text:changed-region><\/text:tracked-changes>/u
		)
		expect(content).toContain(
			'<text:p>One <text:change-start text:change-id="ctFilen1"/>new <text:change-end text:change-id="ctFilen1"/>two <text:change text:change-id="ctFilen2"/></text:p>'
		)
	})

	it("writes a paragraph inserted into a section inside the section", async () => {
		const bytes = odtBytes({
			body: '<text:p>Before</text:p><text:section text:name="Part"><text:p>First of part</text:p><text:p>Second of part</text:p></text:section>'
		})
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[1]

		if (first === undefined) throw new Error("no paragraph")

		editing.session.dispatch(editing.session.state.tr.split(first.pos + 6))

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toContain(
			'<text:section text:name="Part"><text:p>First</text:p><text:p><text:s/>of part</text:p><text:p>Second of part</text:p></text:section>'
		)
	})

	it("writes a page set up anew to its page layout", async () => {
		const bytes = odtBytes({ body: "<text:p>One</text:p><text:p>Two</text:p>" })
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1)
		expect(
			await editing.editor.execute({
				type: "page.setup",
				orientation: "landscape",
				margins: { left: 1080 },
				columns: { count: 2, space: 360, separator: false }
			} as DocxEditorCommand)
		).toBe(true)

		const written = (await saveOdt(editing)).bytes

		const styles = await entry(written, "styles.xml")

		expect(styles).toContain(
			'<style:page-layout-properties fo:page-width="841.9pt" fo:page-height="595.3pt" fo:margin-top="56.7pt" fo:margin-bottom="56.7pt" fo:margin-left="54pt" fo:margin-right="56.7pt" style:print-orientation="landscape">'
		)
		expect(styles).toContain('<style:columns fo:column-count="2" fo:column-gap="18pt"></style:columns>')
		expect(await entry(written, "content.xml")).toBe(await entry(bytes, "content.xml"))
	})

	it("gives a page set up in a document without master pages a page layout and the master page naming it", async () => {
		const bytes = odtBytes({ body: "<text:p>One</text:p>", stylesAutomatic: "", masters: "" })
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1)
		expect(await editing.editor.execute({ type: "page.setup", orientation: "landscape" } as DocxEditorCommand)).toBe(true)

		const styles = await entry((await saveOdt(editing)).bytes, "styles.xml")

		expect(styles).toMatch(
			/<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="[\d.]+pt" fo:page-height="[\d.]+pt" style:print-orientation="landscape"/u
		)
		expect(styles).toMatch(
			/<office:master-styles><style:master-page style:name="Standard\d*" style:page-layout-name="pm1"\/><\/office:master-styles>/u
		)
	})

	it("moves a header's spacing with its distance, and fixes the width of a table that follows the page", async () => {
		const bytes = odtBytes({
			automatic:
				'<style:style style:name="Table1" style:family="table"><style:table-properties table:align="margins"/></style:style><style:style style:name="Table1.A" style:family="table-column"><style:table-column-properties style:rel-column-width="1*"/></style:style>',
			body: '<text:p>One</text:p><table:table table:name="T" table:style-name="Table1"><table:table-column table:style-name="Table1.A" table:number-columns-repeated="2"/><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>',
			stylesAutomatic:
				'<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/><style:header-style><style:header-footer-properties fo:min-height="0cm" fo:margin-bottom="0.5cm"/></style:header-style></style:page-layout>',
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>Head</text:p></style:header></style:master-page>'
		})
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1)
		expect(
			await editing.editor.execute({
				type: "page.setup",
				margins: { top: 2268, left: 1080 },
				columns: { count: 2, space: 360, separator: false }
			} as DocxEditorCommand)
		).toBe(true)

		const written = (await saveOdt(editing)).bytes
		const styles = await entry(written, "styles.xml")
		const content = await entry(written, "content.xml")

		// The header stays at its distance; the text starts lower by the header's grown extent.
		expect(styles).toContain('fo:margin-top="56.7pt"')
		expect(styles).toMatch(
			/<style:header-style><style:header-footer-properties fo:min-height="[\d.]+pt" fo:margin-bottom="14.15pt"\/><\/style:header-style>/u
		)
		// The table keeps the width it showed (ODF's margins-wide table would follow the narrower column).
		expect(content).toMatch(/<table:table table:name="T" table:style-name="Table\d+">/u)
		expect(content).toMatch(
			/<style:style style:name="Table\d+" style:family="table"><style:table-properties style:width="[\d.]+pt" table:align="left"\/><\/style:style>/u
		)
	})

	it("writes a section's new columns to a section style of its own, and refuses setting up its page", async () => {
		const bytes = odtBytes({
			automatic:
				'<style:style style:name="Sect1" style:family="section"><style:section-properties fo:background-color="transparent"><style:columns fo:column-count="2" fo:column-gap="18pt"/></style:section-properties></style:style>',
			body: '<text:p>Before</text:p><text:section text:name="S" text:style-name="Sect1"><text:p>In one</text:p><text:p>In two</text:p></text:section><text:p>After</text:p>'
		})
		const columns = async (): Promise<Awaited<ReturnType<typeof editOdt>>> => {
			const editing = await editOdt(bytes)
			const inside = paragraphs(editing.session.state.doc)[1]

			if (inside === undefined) throw new Error("no paragraph")

			select(editing, inside.pos + 1)

			return editing
		}
		const editing = await columns()

		expect(
			await editing.editor.execute({ type: "page.setup", columns: { count: 3, space: 720, separator: false } } as DocxEditorCommand)
		).toBe(true)

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toMatch(/<text:section text:name="S" text:style-name="(Sect\d+)"><text:p>In one<\/text:p>/u)
		expect(content).toMatch(
			/<style:style style:name="Sect\d+" style:family="section"><style:section-properties fo:background-color="transparent"><style:columns fo:column-count="3" fo:column-gap="36pt"><\/style:columns><\/style:section-properties><\/style:style>/u
		)
		expect(content).toContain('<style:style style:name="Sect1" style:family="section">')

		const page = await columns()

		expect(await page.editor.execute({ type: "page.setup", orientation: "landscape" } as DocxEditorCommand)).toBe(true)
		await expect(saveOdt(page)).rejects.toThrow(OdtWriteRefusal)
	})

	it("writes a section break as the next paragraph starting a copy of its master page, and removes one", async () => {
		const bytes = odtBytes({ body: "<text:p>One</text:p><text:p>Two</text:p><text:p>Three</text:p>" })
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 3)
		expect(await editing.editor.execute({ type: "insert.sectionBreak", kind: "nextPage" } as DocxEditorCommand)).toBe(true)

		const written = (await saveOdt(editing)).bytes
		const content = await entry(written, "content.xml")
		const styles = await entry(written, "styles.xml")

		expect(styles).toContain('<style:master-page style:name="Standard_1" style:page-layout-name="pm1"/>')
		expect(content).toMatch(/<style:style style:name="P1" style:family="paragraph" style:master-page-name="Standard_1"\/>/u)

		// The written file, opened and the break deleted again (its paragraph's sectPr gone, as the docx writer writes it).
		const again = await editOdt(written)
		const body = decodeUtf8(again.source.translation.parts.get("word/document.xml") as Uint8Array)
		const unbroken = body.replace(/<w:sectPr>(?:(?!<\/w:sectPr>)[\s\S])*<\/w:sectPr>(?=<\/w:pPr>)/u, "")

		expect(unbroken).not.toBe(body)

		const removed = await entry(
			(await writeOdt(again.source, { parts: new Map([["word/document.xml", new TextEncoder().encode(unbroken)]]) })).bytes,
			"content.xml"
		)

		expect(removed).not.toContain('text:style-name="P1"')
	})

	it("writes a changed paragraph style where it is, keeping its name and what else it states", async () => {
		const bytes = document('<text:h text:style-name="Heading_20_1" text:outline-level="1">Title</text:h><text:p>Body</text:p>')
		const editing = await editOdt(bytes)
		const translated = editing.source.translation.parts.get("word/styles.xml") as Uint8Array
		const styles = decodeUtf8(translated).replace(
			/(<w:style [^>]*w:styleId="Heading_20_1"[\s\S]*?)<w:sz w:val="36"\/>/u,
			'$1<w:sz w:val="40"/><w:color w:val="FF0000"/>'
		)

		expect(styles).not.toBe(decodeUtf8(translated))

		const written = await writeOdt(editing.source, { parts: new Map([["word/styles.xml", new TextEncoder().encode(styles)]]) })
		const stylesXml = await entry(written.bytes, "styles.xml")

		expect(stylesXml).toMatch(
			/<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="1"><style:text-properties [^>]*fo:font-size="20pt"/u
		)
		expect(stylesXml).toMatch(/style:name="Heading_20_1"[^>]*><style:text-properties [^>]*fo:color="#ff0000"/u)
		expect(stylesXml).toMatch(/style:name="Heading_20_1"[^>]*><style:text-properties [^>]*fo:font-weight="bold"/u)
		expect(await entry(written.bytes, "content.xml")).toBe(await entry(bytes, "content.xml"))
	})

	it("rewrites the levels of a changed list definition in its list style, keeping its name and other levels", async () => {
		const list =
			'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-18pt" fo:margin-left="36pt"/></style:list-level-properties></text:list-level-style-number>' +
			'<text:list-level-style-bullet text:level="2" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-18pt" fo:margin-left="72pt"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>'
		const bytes = odtBytes({
			automatic: list,
			styles: STYLES,
			body: '<text:list text:style-name="L1"><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list>'
		})
		const editing = await editOdt(bytes)
		const translated = decodeUtf8(editing.source.translation.parts.get("word/numbering.xml") as Uint8Array)
		const numbering = translated.replace(
			/(<w:lvl w:ilvl="0"[^>]*>[\s\S]*?)<w:numFmt w:val="decimal"\/>/u,
			'$1<w:numFmt w:val="lowerRoman"/>'
		)

		expect(numbering).not.toBe(translated)

		const written = await writeOdt(editing.source, { parts: new Map([["word/numbering.xml", new TextEncoder().encode(numbering)]]) })
		const content = await entry(written.bytes, "content.xml")

		expect(content).toMatch(
			/<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="i" style:num-suffix="\.">/u
		)
		expect(content).toContain('<text:list-level-style-bullet text:level="2" text:bullet-char="•">')
		expect(content).toContain('<text:list text:style-name="L1"><text:list-item><text:p>One</text:p>')
	})

	it("refuses a tracked formatting change: ODF records no formatting a change replaced", async () => {
		const bytes = document("<text:p>One two</text:p>")
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		editing.session.context.identity.author = "Filen"
		editing.session.context.review.tracking = true
		select(editing, first.pos + 1, first.pos + 4)
		expect(await editing.editor.execute({ type: "format.bold" })).toBe(true)

		await expect(saveOdt(editing)).rejects.toThrow(/format/u)
	})

	it("writes a text box's new text into its frame, the frame kept", async () => {
		const bytes = odtBytes({
			automatic:
				'<style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:wrap="none" fo:border="0.5pt solid #000000"/></style:style>',
			body: '<text:p>Before<draw:frame draw:style-name="fr1" draw:name="Box" text:anchor-type="paragraph" svg:width="4cm" svg:height="2cm" svg:x="1cm" svg:y="0cm"><draw:text-box><text:p>Box text</text:p></draw:text-box></draw:frame></text:p><text:p>After</text:p>'
		})
		const editing = await editOdt(bytes)
		const translated = decodeUtf8(editing.source.translation.parts.get("word/document.xml") as Uint8Array)
		const edited = translated
			.replace("<w:t>Box text</w:t>", "<w:t>Box text, edited</w:t>")
			.replace('<w:t xml:space="preserve">Box text</w:t>', '<w:t xml:space="preserve">Box text, edited</w:t>')

		expect(edited).not.toBe(translated)

		const written = await writeOdt(editing.source, { parts: new Map([["word/document.xml", new TextEncoder().encode(edited)]]) })
		const content = await entry(written.bytes, "content.xml")

		expect(content).toMatch(
			/<draw:frame draw:style-name="fr1" draw:name="Box" text:anchor-type="paragraph" svg:width="4cm" svg:height="2cm" svg:x="1cm" svg:y="0cm"><draw:text-box><text:p[^>]*>Box text, edited<\/text:p><\/draw:text-box><\/draw:frame>/u
		)
		expect(content).toContain("<text:p>After</text:p>")
	})

	it("starts a page style at a table a section break comes before", async () => {
		const bytes = odtBytes({
			body: '<text:p>One</text:p><table:table table:name="T"><table:table-column/><table:table-row><table:table-cell><text:p>Cell</text:p></table:table-cell></table:table-row></table:table><text:p>After</text:p>'
		})
		const editing = await editOdt(bytes)
		const translated = decodeUtf8(editing.source.translation.parts.get("word/document.xml") as Uint8Array)
		const section = /<w:sectPr>[\s\S]*<\/w:sectPr>(?=<\/w:body>)/u.exec(translated)?.[0] ?? ""
		const edited = translated.replace("<w:body><w:p>", `<w:body><w:p><w:pPr>${section}</w:pPr>`)

		expect(edited).not.toBe(translated)

		const written = await writeOdt(editing.source, { parts: new Map([["word/document.xml", new TextEncoder().encode(edited)]]) })
		const content = await entry(written.bytes, "content.xml")

		expect(content).toMatch(/<table:table table:style-name="Table\d+" table:name="T">/u)
		expect(content).toMatch(/<style:style style:name="Table\d+" style:family="table" style:master-page-name="Standard_\d*">/u)
	})

	it("makes a header's spacing a paragraph of its own where the text starts closer than it", async () => {
		const bytes = odtBytes({
			body: "<text:p>One</text:p>",
			stylesAutomatic:
				'<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/><style:header-style><style:header-footer-properties fo:min-height="0cm" fo:margin-bottom="0.5cm"/></style:header-style></style:page-layout>',
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>Head</text:p></style:header></style:master-page>'
		})
		const editing = await editOdt(bytes)
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		select(editing, first.pos + 1)
		expect(await editing.editor.execute({ type: "page.setup", margins: { top: 1134 } } as DocxEditorCommand)).toBe(true)

		const styles = await entry((await saveOdt(editing)).bytes, "styles.xml")

		expect(styles).toContain('<style:header-footer-properties fo:min-height="0pt" fo:margin-bottom="0pt"/>')
		expect(styles).toMatch(/<style:header><text:p>Head<\/text:p><text:p text:style-name="P\d+"\/><\/style:header>/u)
		expect(styles).toMatch(
			/<style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:line-height="14.15pt"\/><style:text-properties fo:font-size="1pt"\/>/u
		)
	})

	it("keeps the side a frame with optimal wrapping shows when the page is set up anew", async () => {
		const bytes = odtBytes({
			automatic:
				'<style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:wrap="dynamic" style:horizontal-pos="from-left" style:horizontal-rel="paragraph"/></style:style>',
			body: '<text:p>One<draw:frame draw:style-name="fr1" draw:name="Box" text:anchor-type="paragraph" svg:width="4cm" svg:height="2cm" svg:x="1cm" svg:y="0cm"><draw:text-box><text:p>Box</text:p></draw:text-box></draw:frame></text:p><text:p>Two</text:p>'
		})
		const editing = await editOdt(bytes)
		const last = paragraphs(editing.session.state.doc).at(-1)

		if (last === undefined) throw new Error("no paragraph")

		select(editing, last.pos + 1)
		expect(await editing.editor.execute({ type: "page.setup", orientation: "landscape" } as DocxEditorCommand)).toBe(true)

		const content = await entry((await saveOdt(editing)).bytes, "content.xml")

		expect(content).toMatch(/<draw:frame draw:style-name="(fr\d+)" draw:name="Box"/u)
		expect(content).toMatch(/<style:style style:name="fr\d+" style:family="graphic"><style:graphic-properties style:wrap="right" /u)
	})

	it("locks blocks a rewrite would lose something of", async () => {
		const bytes = document('<text:p>Indexed <text:toc-mark text:string-value="Indexed"/>entry</text:p><text:p>Plain</text:p>')
		const editing = await editOdt(bytes)
		const proof = await proveOdt(editing.source)

		expect(proof.locked).toHaveLength(1)
		expect(editing.locked).toBe(1)
	})

	it("refuses an edit in a block it cannot rewrite", async () => {
		const bytes = document('<text:p>Indexed <text:toc-mark text:string-value="Indexed"/>entry</text:p>')
		const editing = await editOdt(bytes, { prove: false })
		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		editing.session.dispatch(editing.session.state.tr.insertText("x", first.pos + 1))

		await expect(saveOdt(editing)).rejects.toBeInstanceOf(OdtWriteRefusal)
	})
})
