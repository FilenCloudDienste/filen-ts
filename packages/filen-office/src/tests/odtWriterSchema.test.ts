import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextSelection } from "prosemirror-state"
import { afterAll, describe, expect, it } from "vitest"
import type { DocxEditorCommand } from "@filen/office/core/docx/edit"
import { odtBytes } from "./odtFixtures"
import { decodeUtf8 } from "@filen/office/core/xml"
import { writeOdt } from "../core/odt/write/writer"
import { ODT_EDITS, editOdt, odtEditsOf, saveOdt, scriptedOdtEdits } from "./odtWriteFixtures"
import { paragraphs } from "./rtfWriteFixtures"

// What the ODT writer generates, on an ODF 1.3 document with nothing foreign in it: every scripted edit and a new
// table, saved. FILEN_OFFICE_ODT_WRITE_SCHEMA_OUT names a directory the saves go to, for jing against the OASIS ODF 1.3
// RELAX NG schema. FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar> checks every save against ODF 1.3 here (0 errors
// each), in a scratch directory when no _OUT is given. Opt-in.

const OUT = process.env["FILEN_OFFICE_ODT_WRITE_SCHEMA_OUT"] || undefined
const ODF_VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""

const SOURCE = odtBytes({
	automatic:
		'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>' +
		'<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>' +
		'<style:style style:name="C1" style:family="table-cell"><style:table-cell-properties fo:background-color="#ffff00" fo:padding="0.1cm" fo:border="0.5pt solid #000000"/></style:style>',
	styles: '<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph" style:class="text"/>',
	body:
		'<text:p text:style-name="P1">A centred first paragraph</text:p><text:p>Second paragraph with <text:span text:style-name="T1">italic words</text:span> in it</text:p>' +
		"<text:p>Third paragraph, to be deleted</text:p><text:p>Fourth paragraph, to be a list</text:p><text:p>Fifth paragraph, to be a heading</text:p><text:p>Sixth paragraph, a table after it</text:p>" +
		'<table:table table:name="Table1"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell table:style-name="C1" office:value-type="string"><text:p>Cell one</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Cell two</text:p></table:table-cell></table:table-row></table:table>' +
		"<text:p>Last paragraph</text:p>"
})

describe.skipIf(OUT === undefined && ODF_VALIDATOR === "")("ODT writer output against the ODF 1.3 schema", () => {
	const out = OUT ?? mkdtempSync(join(tmpdir(), "filen-office-odt-schema-"))

	afterAll(() => {
		if (OUT === undefined) rmSync(out, { recursive: true, force: true })
	})

	it("writes each edit", { timeout: 120_000 }, async () => {
		mkdirSync(out, { recursive: true })

		const all = await editOdt(SOURCE)

		expect(new Set(await scriptedOdtEdits(all))).toEqual(new Set(ODT_EDITS))
		writeFileSync(join(out, "all-edits.odt"), (await saveOdt(all)).bytes)

		// A paragraph style and a list definition changed where they are.
		const definitions = await editOdt(SOURCE)

		await scriptedOdtEdits(definitions, ["list", "heading"])

		const parts = new Map((await odtEditsOf(definitions)).parts)
		const styles = decodeUtf8(
			parts.get("word/styles.xml") ?? (definitions.source.translation.parts.get("word/styles.xml") as Uint8Array)
		)
		const numbering = parts.get("word/numbering.xml")

		parts.set(
			"word/styles.xml",
			new TextEncoder().encode(
				styles.replace(/<w:style [^>]*w:styleId="Standard"[^>]*>[\s\S]*?<\/w:style>/u, style =>
					style.includes("<w:pPr>")
						? style.replace("<w:pPr>", '<w:pPr><w:jc w:val="both"/>')
						: style.replace(/(<w:rPr>|<\/w:style>)/u, '<w:pPr><w:jc w:val="both"/></w:pPr>$1')
				)
			)
		)

		if (numbering !== undefined)
			parts.set(
				"word/numbering.xml",
				new TextEncoder().encode(decodeUtf8(numbering).replace('<w:lvlJc w:val="left"/>', '<w:lvlJc w:val="center"/>'))
			)

		writeFileSync(join(out, "definitions.odt"), (await writeOdt(definitions.source, { parts })).bytes)

		// A section's columns.
		const sections = await editOdt(
			odtBytes({
				automatic:
					'<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="2" fo:column-gap="18pt"/></style:section-properties></style:style>',
				body: '<text:p>Before</text:p><text:section text:name="S" text:style-name="Sect1"><text:p>In one</text:p><text:p>In two</text:p></text:section><text:p>After</text:p>'
			})
		)
		const inside = paragraphs(sections.session.state.doc)[1]

		if (inside === undefined) throw new Error("no paragraph")

		sections.session.dispatch(sections.session.state.tr.setSelection(TextSelection.create(sections.session.state.doc, inside.pos + 1)))
		expect(
			await sections.editor.execute({ type: "page.setup", columns: { count: 3, space: 720, separator: true } } as DocxEditorCommand)
		).toBe(true)
		writeFileSync(join(out, "section-columns.odt"), (await saveOdt(sections)).bytes)

		// A text box written into, and a section break before a table.
		const boxed = await editOdt(
			odtBytes({
				automatic:
					'<style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:wrap="dynamic"/></style:style>',
				body: '<text:p>Before<draw:frame draw:style-name="fr1" draw:name="Box" text:anchor-type="paragraph" svg:width="4cm" svg:height="2cm" svg:x="1cm" svg:y="0cm"><draw:text-box><text:p>Box text</text:p></draw:text-box></draw:frame></text:p><table:table table:name="T"><table:table-column/><table:table-row><table:table-cell><text:p>Cell</text:p></table:table-cell></table:table-row></table:table><text:p>After</text:p>'
			})
		)
		const boxXml = decodeUtf8(boxed.source.translation.parts.get("word/document.xml") as Uint8Array)
		const sectPr = /<w:sectPr>[\s\S]*<\/w:sectPr>(?=<\/w:body>)/u.exec(boxXml)?.[0] ?? ""
		const boxEdited = boxXml
			.replace(">Box text<", ">Box text, edited<")
			.replace("<w:body><w:p>", `<w:body><w:p><w:pPr>${sectPr}</w:pPr>`)

		writeFileSync(
			join(out, "text-box.odt"),
			(await writeOdt(boxed.source, { parts: new Map([["word/document.xml", new TextEncoder().encode(boxEdited)]]) })).bytes
		)

		// A page set up in a document without master pages.
		const bare = await editOdt(odtBytes({ body: "<text:p>One</text:p>", stylesAutomatic: "", masters: "" }))
		const only = paragraphs(bare.session.state.doc)[0]

		if (only === undefined) throw new Error("no paragraph")

		bare.session.dispatch(bare.session.state.tr.setSelection(TextSelection.create(bare.session.state.doc, only.pos + 1)))
		expect(
			await bare.editor.execute({
				type: "page.setup",
				orientation: "landscape",
				columns: { count: 2, space: 360, separator: false }
			} as DocxEditorCommand)
		).toBe(true)
		writeFileSync(join(out, "first-page-layout.odt"), (await saveOdt(bare)).bytes)

		const table = await editOdt(SOURCE)
		const last = paragraphs(table.session.state.doc).at(-1)

		if (last === undefined) throw new Error("no paragraph")

		table.session.dispatch(table.session.state.tr.setSelection(TextSelection.create(table.session.state.doc, last.pos + 1)))
		expect(await table.editor.execute({ type: "table.insert", rows: 2, cols: 3 } as DocxEditorCommand)).toBe(true)
		writeFileSync(join(out, "new-table.odt"), (await saveOdt(table)).bytes)
	})

	it.skipIf(ODF_VALIDATOR === "")("writes saves odfvalidator finds no ODF 1.3 error in", { timeout: 120_000 }, () => {
		const saves = readdirSync(out)
			.filter(name => name.endsWith(".odt"))
			.map(name => join(out, name))
		expect(existsSync(ODF_VALIDATOR), ODF_VALIDATOR).toBe(true)

		const run = spawnSync("java", ["-jar", ODF_VALIDATOR, "-1.3", ...saves], { encoding: "utf8", maxBuffer: 1 << 26 })

		expect(run.error).toBeUndefined()
		expect(saves.length).toBe(6)
		expect(`${run.stdout}\n${run.stderr}`.split("\n").filter(line => /:\s+(?:Error|Fatal):/u.test(line))).toEqual([])
	})
})
