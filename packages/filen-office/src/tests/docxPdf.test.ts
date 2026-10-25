import { describe, expect, it } from "vitest"
import { openPdf, pageText, paragraph, pdfOf, snapshotOf, structRoles, structuredDocx } from "./docxPdfFixtures"
import { RevisionView } from "@filen/office/core/docx"
import { cellOrder } from "../core/docx/pdf/paint"
import type { DocxPdfCell, DocxPdfRole } from "../core/docx/pdf/types"
import { bookmarkIndex } from "../dom/docx/links"
import { buildDocx } from "./docxSynthetic"
import { layOut } from "./layoutFixtures"
import { embeddedFontNames } from "./pdfWriteFixtures"

interface StructNode {
	readonly role?: string
	readonly children?: readonly StructNode[]
}

describe("DOCX to PDF", () => {
	it("draws every page's text as extractable text, headers and footers included", async () => {
		const document = await snapshotOf(structuredDocx())
		const { bytes, report } = await pdfOf(document)
		const pdf = await openPdf(bytes)
		const text = await pageText(pdf, 1)

		expect(pdf.numPages).toBe(document.pages.length)

		for (const word of [
			"Introduction",
			"website",
			"First item",
			"Name",
			"Alpha",
			"Closing words.",
			"Running header",
			"Running footer",
			"A note."
		]) {
			expect(text).toContain(word)
		}

		expect(report.missing.size).toBe(0)
	})

	it("tags headings, the list, the table with its header row and the paragraphs; headers and footers are artifacts", async () => {
		const pdf = await openPdf((await pdfOf(await snapshotOf(structuredDocx()))).bytes)
		const roles = await structRoles(pdf, 1)

		expect(roles).toEqual(expect.arrayContaining(["Document", "H1", "H2", "P", "L", "LI", "LBody", "Table", "TR", "TH", "TD", "Link"]))
		expect(roles.indexOf("H1")).toBeLessThan(roles.indexOf("L"))
		expect(roles.indexOf("TH")).toBeLessThan(roles.indexOf("TD"))

		const marked = await (await pdf.getPage(1)).getTextContent({ includeMarkedContent: true })
		const artifacts = marked.items.filter(
			item =>
				"type" in item &&
				(item.type === "beginMarkedContent" || item.type === "beginMarkedContentProps") &&
				Reflect.get(item, "tag") === "Artifact"
		).length

		expect(artifacts).toBeGreaterThan(0)
	})

	it("sets the document's title, language and the heading outline", async () => {
		const pdf = await openPdf((await pdfOf(await snapshotOf(structuredDocx()))).bytes)
		const metadata = await pdf.getMetadata()
		const outline = await pdf.getOutline()

		expect((metadata.info as { Title?: string }).Title).toBe("Quarterly report")
		expect(outline.map(entry => entry.title)).toEqual(["Introduction"])
		expect(outline[0]?.items.map(entry => entry.title)).toEqual(["Details"])
		expect(outline[0]?.dest).not.toBeNull()
	})

	it("takes the language from the theme font languages, else the app's, when the document defaults have none", async () => {
		const lang = async (settings: string | undefined, appLang?: string): Promise<string | null> => {
			const docx = buildDocx({ body: paragraph("Hello"), ...(settings === undefined ? {} : { settings }) })
			const { bytes } = await pdfOf(await snapshotOf(docx), { deflate: null, ...(appLang === undefined ? {} : { lang: appLang }) })

			return /\/Lang \(([^)]*)\)/.exec(Buffer.from(bytes).toString("latin1"))?.[1] ?? null
		}

		expect(await lang('<w:themeFontLang w:val="de-DE" w:eastAsia="ja-JP"/>', "fr")).toBe("de-DE")
		expect(await lang('<w:themeFontLang w:eastAsia="ja-JP"/>')).toBe("ja-JP")
		expect(await lang(undefined, "fr")).toBe("fr")
		expect(await snapshotOf(structuredDocx()).then(document => document.lang)).toBe("en-GB")
	})

	it("writes the language as a well-formed BCP 47 tag, else the next candidate's, else the app's", async () => {
		const lang = async (defaults: string | undefined, settings: string | undefined, appLang?: string): Promise<string | null> => {
			const styles =
				defaults === undefined
					? undefined
					: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="${defaults}"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`
			const docx = buildDocx({
				body: paragraph("Hello"),
				...(settings === undefined ? {} : { settings }),
				...(styles === undefined
					? {}
					: {
							relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }],
							parts: [
								{
									name: "word/styles.xml",
									contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
									data: styles
								}
							]
						})
			})
			const { bytes } = await pdfOf(await snapshotOf(docx), { deflate: null, ...(appLang === undefined ? {} : { lang: appLang }) })
			const text = Buffer.from(bytes).toString("latin1")
			const catalog = /\/Lang \(([^)]*)\)/.exec(text)?.[1] ?? null

			// The XMP's dc:language says the same.
			expect(/<dc:language><rdf:Bag><rdf:li>([^<]*)</.exec(text)?.[1] ?? null).toBe(catalog)

			return catalog
		}

		// A Windows language identifier (ST_Lang's hex form) is its tag.
		expect(await lang("0409", undefined, "fr")).toBe("en-US")
		// Word's sort-order suffix goes; an underscore separates subtags as a hyphen.
		expect(await lang("es-ES_tradnl", undefined, "fr")).toBe("es-ES")
		expect(await lang("en_US", undefined, "fr")).toBe("en-US")
		// An identifier no table knows (RTF's \lang255 written as 00FF) is no language: the theme's next, else the app's.
		expect(await lang("00FF", '<w:themeFontLang w:val="x-bad tag" w:eastAsia="ja-JP"/>', "fr")).toBe("ja-JP")
		expect(await lang("00FF", undefined, "fr")).toBe("fr")
		expect(await lang("00FF", undefined)).toBeNull()
	})

	it("tags a row's cells in order when a cell's later paragraph is laid out after the next cells", () => {
		const columns = [0, 1, 2].map(() => ({ span: 1, top: 0, end: 0 }))
		const cell = (table: number, row: number, index: number): DocxPdfCell => ({ table, row, cell: index, header: false, columns })
		const role = (...cells: DocxPdfCell[]): DocxPdfRole => ({ kind: "paragraph", level: 0, list: 0, cells })
		// Sources: 0 before the table; row 0 cells 0, 1, 2, then cell 0's second paragraph; a nested table in
		// cell 1 of row 1 whose second cell comes first; 9 after the table.
		const roles: DocxPdfRole[] = [
			role(),
			role(cell(1, 0, 0)),
			role(cell(1, 0, 1)),
			role(cell(1, 0, 2)),
			role(cell(1, 0, 0)),
			role(cell(1, 1, 1), cell(2, 0, 1)),
			role(cell(1, 1, 1), cell(2, 0, 0)),
			role(cell(1, 1, 0)),
			role(cell(1, 1, 2)),
			role()
		]

		expect(cellOrder([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], source => roles[source] ?? role())).toEqual([0, 1, 4, 2, 3, 7, 6, 5, 8, 9])
	})

	it("tags a table's rows in row order when a merged cell's content is laid out after later rows", () => {
		const columns = [
			{ span: 1, top: 0, end: 3 },
			{ span: 1, top: 0, end: 0 }
		]
		const cell = (row: number, index: number): DocxPdfCell => ({ table: 1, row, cell: index, header: false, columns })
		const role = (...cells: DocxPdfCell[]): DocxPdfRole => ({ kind: "paragraph", level: 0, list: 0, cells })
		// A page piece of a table: rows 2 and 3, then the rest of row 1's merged cell (a row of the page before), then
		// a second table; 0 before the tables, 6 after.
		const roles: DocxPdfRole[] = [
			role(),
			role(cell(2, 1)),
			role(cell(3, 1)),
			role(cell(1, 0)),
			role(cell(1, 1)),
			role({ table: 2, row: 0, cell: 0, header: false, columns: [{ span: 1, top: 0, end: 0 }] }),
			role()
		]

		expect(cellOrder([0, 1, 2, 3, 4, 5, 6], source => roles[source] ?? role())).toEqual([0, 3, 4, 1, 2, 5, 6])
	})

	it("titles a document without a title of its own by the name it is given", async () => {
		const pdf = await openPdf((await pdfOf(await snapshotOf(structuredDocx({ title: false }), { title: "Budget 2026" }))).bytes)

		expect(((await pdf.getMetadata()).info as { Title?: string }).Title).toBe("Budget 2026")
	})

	it("links external targets and bookmarks inside the document", async () => {
		const pdf = await openPdf((await pdfOf(await snapshotOf(structuredDocx()))).bytes)
		const annotations = await (await pdf.getPage(1)).getAnnotations()
		const links = annotations.filter(annotation => annotation.subtype === "Link")

		expect(links.some(link => link.url === "https://example.com/report")).toBe(true)

		const internal = links.find(link => link.dest !== undefined && link.dest !== null)

		expect(internal?.dest).toBe("details")
		expect(await pdf.getDestination("details")).not.toBeNull()
	})

	it("refuses links the link policy refuses instead of writing them", async () => {
		const docx = buildDocx({
			body: '<w:p><w:hyperlink r:id="rIdJs"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>',
			relationships: [{ id: "rIdJs", type: "hyperlink", target: "javascript:alert(1)", external: true }]
		})
		const { bytes, report } = await pdfOf(await snapshotOf(docx))
		const pdf = await openPdf(bytes)

		expect((await (await pdf.getPage(1)).getAnnotations()).filter(annotation => annotation.subtype === "Link")).toHaveLength(0)
		expect(await pageText(pdf, 1)).toContain("click")
		expect(report.refused.get("link")).toBe(1)
	})

	it("encrypts the PDF with the password it is given", async () => {
		const { bytes } = await pdfOf(await snapshotOf(structuredDocx()), { password: "geheim 1" })

		await expect(openPdf(bytes)).rejects.toThrow()

		const pdf = await openPdf(bytes, "geheim 1")

		expect(await pageText(pdf, 1)).toContain("Introduction")
	})

	it("writes the same bytes for the same document when deterministic", async () => {
		const document = await snapshotOf(structuredDocx())
		const a = await pdfOf(document)
		const b = await pdfOf(document)

		expect(a.bytes).toEqual(b.bytes)
	})

	it("stops when the export is aborted", async () => {
		const document = await snapshotOf(structuredDocx())

		await expect(pdfOf(document, { signal: { aborted: true } })).rejects.toThrow(/aborted/)
	})

	it("reports pages as they are written", async () => {
		const many = Array.from({ length: 6 }, (_, k) => paragraph(`Page ${k + 1}`) + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>').join(
			""
		)
		const document = await snapshotOf(buildDocx({ body: many }))
		const progress: [number, number][] = []

		await pdfOf(document, { onProgress: (done, total) => progress.push([done, total]) })

		expect(progress.length).toBe(document.pages.length)
		expect(progress.at(-1)).toEqual([document.pages.length, document.pages.length])
	})

	it("marks a table's header row repeated on the next page as an artifact", async () => {
		const rows = Array.from({ length: 70 }, (_, k) => `<w:tr><w:tc><w:p><w:r><w:t>Row ${k}</w:t></w:r></w:p></w:tc></w:tr>`).join("")
		const docx = buildDocx({
			body:
				'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="8000"/></w:tblGrid>' +
				"<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Heading cell</w:t></w:r></w:p></w:tc></w:tr>" +
				rows +
				"</w:tbl>"
		})
		const document = await snapshotOf(docx)

		expect(document.pages.length).toBeGreaterThan(1)

		const pdf = await openPdf((await pdfOf(document)).bytes)

		expect(await structRoles(pdf, 1)).toContain("TH")
		expect(await structRoles(pdf, 2)).not.toContain("TH")
		expect(await pageText(pdf, 2)).toContain("Heading cell")
	})

	it("tags every table row with as many columns, skipped grid columns and spans included", async () => {
		const docx = buildDocx({
			body:
				'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
				"<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>" +
				'<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr>' +
				"</w:tbl>"
		})
		const pdf = await openPdf((await pdfOf(await snapshotOf(docx))).bytes)
		const tree = (await (await pdf.getPage(1)).getStructTree()) as unknown as StructNode
		const rows: StructNode[] = []
		const visit = (node: StructNode): void => {
			if (node.role === "TR") rows.push(node)

			for (const child of node.children ?? []) visit(child)
		}

		visit(tree)

		expect(rows).toHaveLength(2)
		expect(rows.map(row => (row.children ?? []).filter(child => child.role === "TD").length)).toEqual([3, 2])
	})

	it("tags a vertically merged cell once, with its RowSpan, and nothing for the positions it covers", async () => {
		const cell = (text: string, merge?: string) =>
			`<w:tc>${merge === undefined ? "" : `<w:tcPr><w:vMerge${merge === "restart" ? ' w:val="restart"' : ""}/></w:tcPr>`}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
		const docx = buildDocx({
			body:
				'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
				`<w:tr>${cell("Merged", "restart")}${cell("One")}</w:tr>` +
				`<w:tr>${cell("", "continue")}${cell("Two")}</w:tr>` +
				`<w:tr>${cell("", "continue")}${cell("Three")}</w:tr>` +
				"</w:tbl>"
		})
		const { bytes } = await pdfOf(await snapshotOf(docx), { deflate: null })
		const pdf = await openPdf(bytes)
		const tree = (await (await pdf.getPage(1)).getStructTree()) as unknown as StructNode
		const rows: StructNode[] = []
		const visit = (node: StructNode): void => {
			if (node.role === "TR") rows.push(node)

			for (const child of node.children ?? []) visit(child)
		}

		visit(tree)

		expect(rows.map(row => (row.children ?? []).filter(child => child.role === "TD").length)).toEqual([2, 1, 1])
		expect(new TextDecoder("latin1").decode(bytes)).toContain("/RowSpan 3")
	})

	it("tags a merge that continues on the next page once there too", async () => {
		const cell = (text: string, merge?: string) =>
			`<w:tc>${merge === undefined ? "" : `<w:tcPr><w:vMerge${merge === "restart" ? ' w:val="restart"' : ""}/></w:tcPr>`}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from(
			{ length: 70 },
			(_, k) => `<w:tr>${cell(k === 0 ? "Merged" : "", k === 0 ? "restart" : "continue")}${cell(`Row ${k}`)}</w:tr>`
		).join("")
		const document = await snapshotOf(
			buildDocx({
				body: `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>${rows}</w:tbl>`
			})
		)

		expect(document.pages.length).toBeGreaterThan(1)

		const pdf = await openPdf((await pdfOf(document)).bytes)

		for (let page = 1; page <= 2; page++) {
			const tree = (await (await pdf.getPage(page)).getStructTree()) as unknown as StructNode
			const counts: number[] = []
			const visit = (node: StructNode): void => {
				if (node.role === "TR") counts.push((node.children ?? []).filter(child => child.role === "TD").length)

				for (const child of node.children ?? []) visit(child)
			}

			visit(tree)

			// The first row of the page's piece holds the merge (two cells), the others only their own.
			expect(counts[0]).toBe(2)
			expect(counts.slice(1).every(count => count === 1)).toBe(true)
		}
	})

	it("draws a symbol font's private-use codes as the characters they show when a bundled face stands in", async () => {
		const docx = buildDocx({
			body: '<w:p><w:r><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr><w:t>\uF0B7</w:t></w:r></w:p>'
		})
		const document = await snapshotOf(docx)
		// As the layout has it when the symbol font is installed (drawn from it on screen): the code itself.
		const raw = {
			...document,
			pages: document.pages.map(page => ({ ...page, sourceTexts: page.sourceTexts.map(text => text.replace("\u2022", "\uF0B7")) }))
		}

		expect(document.styles.some(style => style.symbolFont === "Symbol")).toBe(true)

		const { bytes, report } = await pdfOf(raw)

		expect(report.missing.size).toBe(0)
		expect(await pageText(await openPdf(bytes), 1)).toContain("\u2022")
	})

	it("finds the bookmarks of a model whose editing layout dropped parts", async () => {
		const { model } = (await layOut(structuredDocx(), { view: RevisionView.Final })).loaded
		const sparse = { ...model, parts: [undefined, ...model.parts] } as unknown as typeof model

		expect(bookmarkIndex(sparse).get("details")?.part).toBe((bookmarkIndex(model).get("details")?.part ?? -2) + 1)
	})

	it("keeps the source text of upper-cased and small-capitals runs extractable", async () => {
		const docx = buildDocx({
			body: '<w:p><w:r><w:rPr><w:caps/></w:rPr><w:t>shout</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:rPr><w:smallCaps/></w:rPr><w:t>Small Caps</w:t></w:r></w:p>'
		})
		const text = await pageText(await openPdf((await pdfOf(await snapshotOf(docx))).bytes), 1)

		expect(text.toLowerCase()).toContain("shout")
		expect(text.toLowerCase()).toContain("small caps")
	})

	it("embeds only subsets of the bundled faces", async () => {
		const fonts = embeddedFontNames((await pdfOf(await snapshotOf(structuredDocx()))).bytes)

		expect(fonts.length).toBeGreaterThan(0)
		expect(fonts.every(name => /^[A-Z]{6}\+/.test(name))).toBe(true)
	})
})
