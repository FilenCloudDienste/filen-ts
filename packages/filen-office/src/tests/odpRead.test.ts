import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { encryptedEntry } from "./odsFixtures"
import { odpBytes, openOdpFixture, page, plainText, slideOf } from "./odpFixtures"

const EMU_PER_CM = 360_000

describe("ODP reader", () => {
	it("opens a deck with its pages listed and parses a page only when it is asked for", async () => {
		const opened = await openOdpFixture({
			body: page(
				'<draw:frame svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>One</text:p></draw:text-box></draw:frame>'
			).repeat(3)
		})

		expect(opened.deck.format).toBe("odp")
		expect(opened.deck.variant).toBe("odp")
		expect(opened.deck.slides).toHaveLength(3)
		expect(opened.deck.slides.some(ref => opened.deck.nodes.has(ref))).toBe(false)
		expect(opened.deck.size).toEqual({ cx: 28 * EMU_PER_CM, cy: 21 * EMU_PER_CM })

		const slide = await slideOf(opened, 1)

		expect(plainText(slide.shapes[0])).toBe("One")
		expect(opened.deck.nodes.has(opened.deck.slides[0] ?? slide.ref)).toBe(false)
		expect(slide.src).toMatchObject({ format: "odp", part: "content.xml" })
	})

	it("refuses an encrypted package as encrypted", async () => {
		const bytes = odpBytes({ body: page(""), manifestEntries: encryptedEntry("Pictures/a.png") })
		const opened = await openOdp(bytesSource(bytes))

		expect(opened.kind === "refused" && opened.reason).toBe("encrypted")
	})

	it("refuses the encrypted presentation fixture (LibreOffice's AES-256 package) as encrypted", async () => {
		const opened = await openOdp(
			bytesSource(new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "presentation", "encrypted.odp"))))
		)

		expect(opened.kind === "refused" && opened.reason).toBe("encrypted")
	})

	it("refuses a spreadsheet given as a presentation, and a damaged package, with typed reasons", async () => {
		const spreadsheet = await openOdp(bytesSource(odpBytes({ body: "", mediaType: "application/vnd.oasis.opendocument.spreadsheet" })))
		const damaged = await openOdp(bytesSource(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))

		expect(spreadsheet.kind === "refused" && spreadsheet.reason).toBe("unsupported")
		expect(damaged.kind === "refused" && damaged.reason).toBe("malformed")
	})

	it("refuses a deck of more pages than the budget while scanning", async () => {
		const bytes = odpBytes({ body: page("").repeat(5) })
		const opened = await openOdp(bytesSource(bytes), { budgets: { ...DEFAULT_PRESENTATION_BUDGETS, slides: 4 } })

		expect(opened.kind === "refused" && opened.reason).toBe("tooLarge")
	})

	it("opens a template as otp", async () => {
		const opened = await openOdpFixture({ body: page(""), mediaType: "application/vnd.oasis.opendocument.presentation-template" })

		expect(opened.deck.variant).toBe("otp")
	})

	it("places a placeholder that writes no box, or says user-transformed false, at its master's shape", async () => {
		const opened = await openOdpFixture({
			body: page(
				'<draw:frame presentation:class="title"><draw:text-box><text:p>T</text:p></draw:text-box></draw:frame>' +
					'<draw:frame presentation:class="outline" presentation:user-transformed="false" svg:x="1cm" svg:y="1cm" svg:width="1cm" svg:height="1cm"><draw:text-box><text:p>B</text:p></draw:text-box></draw:frame>' +
					'<draw:frame presentation:class="title" svg:x="3cm" svg:y="4cm" svg:width="5cm" svg:height="6cm"><draw:text-box><text:p>Own</text:p></draw:text-box></draw:frame>'
			)
		})
		const [title, outline, own] = (await slideOf(opened, 0)).shapes

		expect(title?.ph?.type).toBe("title")
		expect(title?.xfrm).toMatchObject({ x: 2 * EMU_PER_CM, y: 1 * EMU_PER_CM, cx: 24 * EMU_PER_CM, cy: 3 * EMU_PER_CM })
		expect(outline?.ph?.type).toBe("body")
		expect(outline?.xfrm).toMatchObject({ x: 2 * EMU_PER_CM, y: 5 * EMU_PER_CM })
		expect(own?.xfrm).toMatchObject({ x: 3 * EMU_PER_CM, y: 4 * EMU_PER_CM, cx: 5 * EMU_PER_CM, cy: 6 * EMU_PER_CM })
	})

	it("turns draw:transform's corner rotation into DrawingML's centre rotation", async () => {
		// 90° counter-clockwise about the corner, then placed at (5 cm, 10 cm): a 4 × 2 cm box whose corner is there.
		const opened = await openOdpFixture({
			body: page('<draw:rect svg:width="4cm" svg:height="2cm" draw:transform="rotate (1.5707963267949) translate (5cm 10cm)"/>')
		})
		const xfrm = (await slideOf(opened, 0)).shapes[0]?.xfrm

		expect(xfrm?.rot).toBe(270 * 60_000)
		// The centre: (5 + 1, 10 - 2) cm; the unrotated box around it.
		expect(Math.round((xfrm?.x ?? 0) / 3600)).toBe(400)
		expect(Math.round((xfrm?.y ?? 0) / 3600)).toBe(700)
		expect(xfrm?.cx).toBe(4 * EMU_PER_CM)
	})

	it("shows a master's footer on a slide whose page displays it, as a synthetic slide shape", async () => {
		const opened = await openOdpFixture({
			automatic:
				'<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:display-footer="true" presentation:display-page-number="true"/></style:style>' +
				'<style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:display-footer="false"/></style:style>',
			body:
				'<presentation:footer-decl presentation:name="ftr1">Our footer</presentation:footer-decl>' +
				page("", 'draw:master-page-name="M" draw:style-name="dp1" presentation:use-footer-name="ftr1"') +
				page("", 'draw:master-page-name="M" draw:style-name="dp2" presentation:use-footer-name="ftr1"')
		})
		const shown = await slideOf(opened, 0)
		const hidden = await slideOf(opened, 1)
		const footer = shown.shapes.find(shape => shape.ph?.type === "ftr")

		expect(footer).toMatchObject({ synthetic: true })
		expect(plainText(footer)).toBe("Our footer")
		expect(shown.shapes.find(shape => shape.ph?.type === "sldNum")?.text?.paragraphs[0]?.runs[0]).toMatchObject({
			kind: "fld",
			type: "slidenum"
		})
		expect(hidden.shapes).toEqual([])
	})

	it("classifies script and execute event listeners as refused actions, page jumps and links as actions", async () => {
		const listener = (inner: string): string =>
			`<draw:rect svg:width="1cm" svg:height="1cm"><office:event-listeners>${inner}</office:event-listeners></draw:rect>`
		const opened = await openOdpFixture({
			body:
				page(
					listener(
						'<script:event-listener script:language="ooo:script" script:event-name="dom:click" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document"/>'
					) +
						listener(
							'<presentation:event-listener script:event-name="dom:click" presentation:action="execute" xlink:href="file:///bin/sh"/>'
						) +
						listener(
							'<presentation:event-listener script:event-name="dom:click" presentation:action="show" xlink:href="#second"/>'
						) +
						listener(
							'<presentation:event-listener script:event-name="dom:click" presentation:action="show" xlink:href="https://example.com/"/>'
						) +
						listener('<presentation:event-listener script:event-name="dom:click" presentation:action="next-page"/>') +
						'<draw:frame svg:width="1cm" svg:height="1cm"><draw:text-box><text:p><text:a xlink:href="javascript:alert(1)">x</text:a></text:p></draw:text-box></draw:frame>',
					'draw:name="first" draw:master-page-name="M"'
				).replace('draw:name="page" ', "") + '<draw:page draw:name="second" draw:master-page-name="M"/>'
		})
		const shapes = (await slideOf(opened, 0)).shapes

		expect(shapes.map(shape => shape.actions?.click?.kind)).toEqual(["refused", "refused", "slide", "url", "internal", undefined])
		expect(shapes[0]?.actions?.click).toMatchObject({ what: "script" })
		expect(shapes[1]?.actions?.click).toMatchObject({ what: "execute" })
		expect(shapes[2]?.actions?.click).toEqual({ kind: "slide", slide: opened.deck.slides[1] })
		const run = shapes[5]?.text?.paragraphs[0]?.runs[0]

		expect(run?.kind === "r" && run.rPr.hlinkClick).toMatchObject({ kind: "refused", what: "scheme" })
	})

	it("marks a page hidden from its drawing-page style before the page is parsed", async () => {
		const opened = await openOdpFixture({
			automatic:
				'<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>',
			body: page("") + page("", 'draw:master-page-name="M" draw:style-name="dp1"')
		})

		expect([...(opened.deck.hiddenSlides ?? [])]).toEqual([opened.deck.slides[1]])
		expect((await slideOf(opened, 1)).hidden).toBe(true)
	})

	it("reads outline levels from nested lists, with bullets from the list style and indents added to the margin", async () => {
		const opened = await openOdpFixture({
			automatic:
				'<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:min-label-width="1cm"/></text:list-level-style-bullet>' +
				'<text:list-level-style-number text:level="2" style:num-format="1" style:num-suffix="."><style:list-level-properties text:space-before="1cm" text:min-label-width="0.5cm"/></text:list-level-style-number></text:list-style>',
			body: page(
				'<draw:frame presentation:class="outline" svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="10cm"><draw:text-box><text:list text:style-name="L1">' +
					"<text:list-header><text:p>Header</text:p></text:list-header>" +
					"<text:list-item><text:p>One</text:p><text:list><text:list-item><text:p>Two</text:p></text:list-item></text:list></text:list-item>" +
					"</text:list><text:p>Plain</text:p></draw:text-box></draw:frame>"
			)
		})
		const paragraphs = (await slideOf(opened, 0)).shapes[0]?.text?.paragraphs ?? []

		expect(paragraphs.map(paragraph => paragraph.pPr.bullet)).toEqual([
			{ kind: "none" },
			{ kind: "char", char: "•" },
			{ kind: "autoNum", scheme: "arabicPeriod" },
			{ kind: "none" }
		])
		expect(paragraphs.map(paragraph => paragraph.pPr.lvl)).toEqual([0, 0, 1, undefined])
		expect(paragraphs[1]?.pPr).toMatchObject({ marL: EMU_PER_CM, indent: -EMU_PER_CM })
		expect(paragraphs[2]?.pPr).toMatchObject({ marL: 1.5 * EMU_PER_CM, indent: -0.5 * EMU_PER_CM })
	})

	it("collapses whitespace and keeps spaces, tabs, line breaks and fields as written", async () => {
		const opened = await openOdpFixture({
			body: page(
				'<draw:frame svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>  a   b<text:s text:c="2"/>c<text:tab/>d<text:line-break/>e <text:page-number>7</text:page-number></text:p></draw:text-box></draw:frame>'
			)
		})
		const runs = (await slideOf(opened, 0)).shapes[0]?.text?.paragraphs[0]?.runs ?? []

		expect(runs.map(run => (run.kind === "br" ? "\n" : run.kind === "fld" ? `{${run.type}}` : run.text)).join("")).toBe(
			"a b  c\td\ne {slidenum}"
		)
	})

	it("takes a shape's text defaults from its style chain over the graphic default style", async () => {
		const opened = await openOdpFixture({
			styles:
				'<style:default-style style:family="graphic"><style:text-properties fo:font-size="18pt" style:font-name="Base"/></style:default-style>' +
				'<style:style style:name="Big" style:family="graphic"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="32pt" fo:font-weight="bold" fo:color="#ff0000"/></style:style>',
			automatic: '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>',
			body: page(
				'<draw:rect draw:style-name="Big" svg:width="5cm" svg:height="2cm"><text:p>a<text:span text:style-name="T1">b</text:span></text:p></draw:rect>'
			)
		})
		const text = (await slideOf(opened, 0)).shapes[0]?.text
		const level = text?.lstStyle?.levels[0]

		expect(level).toMatchObject({
			algn: "ctr",
			defRPr: { sz: 3200, b: true, fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } }
		})
		expect(text?.paragraphs[0]?.runs.map(run => (run.kind === "r" ? run.rPr : undefined))).toEqual([{}, { i: true }])
	})

	it("sizes East Asian text by its Asian font size", async () => {
		const opened = await openOdpFixture({
			automatic:
				'<style:style style:name="T1" style:family="text"><style:text-properties fo:font-size="10pt" style:font-size-asian="24pt"/></style:style>',
			body: page(
				'<draw:frame svg:width="5cm" svg:height="2cm"><draw:text-box><text:p><text:span text:style-name="T1">ab 梵蒂冈</text:span></text:p><text:p><text:span text:style-name="T1">ab</text:span></text:p></draw:text-box></draw:frame>'
			)
		})
		const paragraphs = (await slideOf(opened, 0)).shapes[0]?.text?.paragraphs ?? []

		expect(paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "r" ? run.rPr.sz : undefined)))).toEqual([
			[2400],
			[1000]
		])
	})

	it("reads fills, lines and shadows from graphic properties and drawing resources", async () => {
		const opened = await openOdpFixture({
			styles:
				'<draw:gradient draw:name="G" draw:style="linear" draw:start-color="#000000" draw:end-color="#ffffff" draw:angle="900" draw:border="0%"/>' +
				'<draw:stroke-dash draw:name="D" draw:style="rect" draw:dots1="1" draw:dots1-length="200%" draw:distance="100%"/>',
			automatic:
				'<style:style style:name="g1" style:family="graphic"><style:graphic-properties draw:fill="gradient" draw:fill-gradient-name="G" draw:stroke="dash" draw:stroke-dash="D" svg:stroke-width="0.1cm" svg:stroke-color="#00ff00" draw:shadow="visible" draw:shadow-offset-x="0.2cm" draw:shadow-offset-y="0cm" draw:shadow-color="#808080"/></style:style>',
			body: page('<draw:ellipse draw:style-name="g1" svg:width="5cm" svg:height="2cm"/>')
		})
		const props = (await slideOf(opened, 0)).shapes[0]?.props

		expect(props?.geometry).toMatchObject({ kind: "preset", preset: "ellipse" })
		// ODF's 90° turns the top-to-bottom gradient counter-clockwise: left to right is DrawingML's 0°.
		expect(props?.fill).toMatchObject({ kind: "gradient", linear: { angle: 0 } })
		expect(props?.ln).toMatchObject({ fill: { kind: "solid", color: { rgb: "00FF00" } } })
		expect(props?.ln !== "none" && props?.ln?.custDash !== undefined && [...props.ln.custDash]).toEqual([200_000, 100_000])
		expect(props?.effects?.effects[0]).toMatchObject({ kind: "outerShdw", dir: 0 })
	})

	it("reads custom shapes through their enhanced geometry, in the shape's own size when the view box is empty", async () => {
		const opened = await openOdpFixture({
			body: page(
				'<draw:custom-shape svg:width="4cm" svg:height="2cm"><draw:enhanced-geometry svg:viewBox="0 0 0 0" draw:text-areas="0 0 ?f1 ?f0" draw:enhanced-path="M 0 0 L ?f1 0 ?f1 ?f0 0 ?f0 Z N"><draw:equation draw:name="f0" draw:formula="logheight"/><draw:equation draw:name="f1" draw:formula="logwidth"/></draw:enhanced-geometry></draw:custom-shape>'
			)
		})
		const geometry = (await slideOf(opened, 0)).shapes[0]?.props?.geometry

		expect(geometry?.kind).toBe("custom")
		if (geometry?.kind !== "custom") return
		expect(geometry.textRect).toEqual({ l: "0", t: "0", r: String(4 * EMU_PER_CM), b: String(2 * EMU_PER_CM) })
		expect([...(geometry.paths[0]?.coords ?? [])]).toEqual([0, 0, 100_000, 0, 100_000, 50_000, 0, 50_000])
	})

	it("reads tables with spans, column widths and template cell styles", async () => {
		const opened = await openOdpFixture({
			styles: '<table:table-template table:name="TT"><table:first-row table:style-name="head"/><table:body table:style-name="body"/></table:table-template>',
			automatic:
				'<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="3cm"/></style:style>' +
				'<style:style style:name="head" style:family="table-cell"><style:graphic-properties draw:fill="solid" draw:fill-color="#112233"/></style:style>' +
				'<style:style style:name="body" style:family="table-cell"><style:graphic-properties draw:fill="none"/></style:style>',
			body: page(
				'<draw:frame svg:width="6cm" svg:height="2cm"><table:table table:template-name="TT" table:use-first-row-styles="true">' +
					'<table:table-column table:style-name="co1" table:number-columns-repeated="2"/>' +
					'<table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>A</text:p></table:table-cell><table:covered-table-cell/></table:table-row>' +
					"<table:table-row><table:table-cell><text:p>B</text:p></table:table-cell><table:table-cell><text:p>C</text:p></table:table-cell></table:table-row>" +
					"</table:table></draw:frame>"
			)
		})
		const frame = (await slideOf(opened, 0)).shapes[0]?.frame

		expect(frame?.kind).toBe("table")
		if (frame?.kind !== "table") return
		expect(frame.table.grid).toEqual([3 * EMU_PER_CM, 3 * EMU_PER_CM])
		expect(frame.table.rows[0]?.cells.map(cell => [cell.gridSpan, cell.hMerge])).toEqual([
			[2, undefined],
			[undefined, true]
		])
		expect(frame.table.rows[0]?.cells[0]?.props?.fill).toMatchObject({ kind: "solid", color: { rgb: "112233" } })
		expect(frame.table.rows[1]?.cells[1]?.props?.fill).toBe("none")
	})

	it("takes a cell's style from its row's default as LibreOffice writes it: fill, borders and text defaults", async () => {
		const opened = await openOdpFixture({
			automatic:
				'<style:style style:name="ce1" style:family="table-cell"><loext:graphic-properties draw:fill="solid" draw:fill-color="#aabbcc" draw:textarea-vertical-align="middle"/>' +
				'<style:paragraph-properties fo:text-align="center" fo:border-bottom="0.5pt solid #000000" fo:border-top="none"/><style:text-properties fo:font-size="14pt"/></style:style>',
			body: page(
				'<draw:frame svg:width="6cm" svg:height="2cm"><table:table><table:table-column/><table:table-row table:default-cell-style-name="ce1"><table:table-cell><text:p>A</text:p></table:table-cell></table:table-row></table:table></draw:frame>'
			)
		})
		const frame = (await slideOf(opened, 0)).shapes[0]?.frame
		const cell = frame?.kind === "table" ? frame.table.rows[0]?.cells[0] : undefined

		expect(cell?.props).toMatchObject({
			fill: { kind: "solid", color: { rgb: "AABBCC" } },
			anchor: "ctr",
			borders: { t: "none", b: { w: 6350, fill: { kind: "solid", color: { rgb: "000000" } } } }
		})
		expect(cell?.text.lstStyle?.levels[0]).toMatchObject({ algn: "ctr", defRPr: { sz: 1400 } })
	})

	it("reads a picture frame and prefers the raster picture of an SVG pair", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const opened = await openOdpFixture({
			extra: [
				{ name: "Pictures/a.svg", data: new TextEncoder().encode("<svg/>"), mediaType: "image/svg+xml" },
				{ name: "Pictures/a.png", data: png, mediaType: "image/png" }
			],
			body: page(
				'<draw:frame svg:width="4cm" svg:height="2cm"><draw:image xlink:href="Pictures/a.svg"/><draw:image xlink:href="Pictures/a.png"/></draw:frame>'
			)
		})
		const shape = (await slideOf(opened, 0)).shapes[0]

		expect(shape?.kind).toBe("pic")
		expect(shape?.props?.fill).toEqual({ kind: "picture", part: "/Pictures/a.png" })
		expect(opened.parts.contentTypes.typeOf("/Pictures/a.png")).toBe("image/png")
	})

	it("crops a clipped picture by fractions of its own size at its resolution", async () => {
		// A 100 × 50 px PNG without pHYs: 75 × 37.5 pt at 96 per inch.
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 100, 0, 0, 0, 50, 8, 6, 0, 0, 0
		])
		const opened = await openOdpFixture({
			extra: [{ name: "Pictures/a.png", data: png, mediaType: "image/png" }],
			automatic:
				'<style:style style:name="g1" style:family="graphic"><style:graphic-properties fo:clip="rect(0pt, 15pt, 7.5pt, 7.5pt)"/></style:style>',
			body: page(
				'<draw:frame draw:style-name="g1" svg:width="4cm" svg:height="2cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame>'
			)
		})

		expect((await slideOf(opened, 0)).shapes[0]?.props?.fill).toEqual({
			kind: "picture",
			part: "/Pictures/a.png",
			crop: { l: 10_000, t: 0, r: 20_000, b: 20_000 }
		})
	})

	it("reads chart objects as charts translated from the object's own table", async () => {
		const chart =
			'<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:chart><chart:chart chart:class="chart:bar"><chart:plot-area><chart:series chart:values-cell-range-address="local-table.$B$2:.$B$3" chart:label-cell-address="local-table.$B$1"/></chart:plot-area><table:table table:name="local-table"><table:table-header-columns><table:table-column/></table:table-header-columns><table:table-columns><table:table-column/></table:table-columns><table:table-header-rows><table:table-row><table:table-cell/><table:table-cell><text:p>S</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-rows><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>b</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell></table:table-row></table:table-rows></table:table></chart:chart></office:chart></office:body></office:document-content>'
		const opened = await openOdpFixture({
			extra: [{ name: "Object 1/content.xml", data: new TextEncoder().encode(chart), mediaType: "text/xml" }],
			manifestEntries:
				'<manifest:file-entry manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"/>',
			body: page('<draw:frame svg:width="8cm" svg:height="6cm"><draw:object xlink:href="./Object 1"/></draw:frame>')
		})
		const frame = (await slideOf(opened, 0)).shapes[0]?.frame

		expect(frame).toEqual({ kind: "chart", part: "/Object 1/chart.xml", workbook: { part: "/Object 1/content.xml", kind: "odfTable" } })
		const markup = opened.parts.document("/Object 1/chart.xml")

		expect(markup).toBeDefined()
		// The values and categories are the object's own table's, as literals.
		const xml = new TextDecoder().decode(markup?.bytes)

		expect(xml).toContain(
			'<c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit>'
		)
		expect(xml).toContain("<c:v>a</c:v>")
	})

	it("lays out a chart whose series run along its table's rows as series of categories", async () => {
		const chart =
			'<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:chart><chart:chart chart:class="chart:bar"><chart:plot-area><chart:axis chart:dimension="x"><chart:categories table:cell-range-address="local-table.$B$1:.$D$1"/></chart:axis><chart:series chart:values-cell-range-address="local-table.$B$2:.$D$2" chart:label-cell-address="local-table.$A$2"/></chart:plot-area><table:table table:name="local-table"><table:table-header-columns><table:table-column/></table:table-header-columns><table:table-header-rows><table:table-row><table:table-cell/><table:table-cell><text:p>Oct</text:p></table:table-cell><table:table-cell><text:p>Nov</text:p></table:table-cell><table:table-cell><text:p>Dec</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-rows><table:table-row><table:table-cell><text:p>Size</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="12"/><table:table-cell office:value-type="float" office:value="13"/><table:table-cell office:value-type="float" office:value="14"/></table:table-row></table:table-rows></table:table></chart:chart></office:chart></office:body></office:document-content>'
		const opened = await openOdpFixture({
			extra: [{ name: "Object 1/content.xml", data: new TextEncoder().encode(chart), mediaType: "text/xml" }],
			manifestEntries:
				'<manifest:file-entry manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"/>',
			body: page('<draw:frame svg:width="8cm" svg:height="6cm"><draw:object xlink:href="./Object 1"/></draw:frame>')
		})

		await slideOf(opened, 0)

		const xml = new TextDecoder().decode(opened.parts.document("/Object 1/chart.xml")?.bytes)

		expect(xml.match(/<c:ser>/gu)).toHaveLength(1)
		expect(xml).toContain("<c:tx><c:v>Size</c:v></c:tx>")
		expect(xml).toContain(
			'<c:ptCount val="3"/><c:pt idx="0"><c:v>Oct</c:v></c:pt><c:pt idx="1"><c:v>Nov</c:v></c:pt><c:pt idx="2"><c:v>Dec</c:v></c:pt>'
		)
		expect(xml).toContain('<c:pt idx="2"><c:v>14</c:v></c:pt>')
	})

	it("reads notes pages, comments, custom shows and the show settings", async () => {
		const opened = await openOdpFixture({
			body:
				page(
					'<officeooo:annotation><text:p>c</text:p></officeooo:annotation><presentation:notes><draw:page-thumbnail presentation:class="page"/><draw:frame presentation:class="notes" svg:width="10cm" svg:height="5cm"><draw:text-box><text:p>Say this</text:p></draw:text-box></draw:frame></presentation:notes>',
					'draw:name="a" draw:master-page-name="M"'
				).replace('draw:name="page" ', "") +
				'<draw:page draw:name="b" draw:master-page-name="M"/>' +
				'<presentation:settings presentation:endless="true" presentation:show="Short"><presentation:show presentation:name="Short" presentation:pages="b,a"/></presentation:settings>'
		})
		const slide = await slideOf(opened, 0)
		const notes = slide.notes === undefined ? undefined : opened.deck.nodes.get(slide.notes)

		expect(plainText(notes?.shapes.find(shape => shape.ph?.type === "body"))).toBe("Say this")
		expect(slide.comments).toHaveLength(1)
		expect(opened.deck.customShows).toEqual([{ name: "Short", id: 0, slides: [opened.deck.slides[1], opened.deck.slides[0]] }])
		expect(opened.deck.show).toMatchObject({ loop: true, range: { kind: "customShow", id: 0 } })
	})

	it("reads a page's transition from its style, the transition filter winning", async () => {
		const opened = await openOdpFixture({
			automatic:
				'<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:transition-type="automatic" presentation:duration="PT3S" smil:type="barWipe" smil:subtype="leftToRight"/></style:style>',
			body: page(
				'<anim:par presentation:node-type="timing-root"><anim:transitionFilter smil:type="fade" smil:subtype="crossfade" smil:dur="1.5s"/></anim:par>',
				'draw:master-page-name="M" draw:style-name="dp1"'
			)
		})
		const transition = (await slideOf(opened, 0)).transition

		expect(transition).toMatchObject({ kind: "fade", durationMs: 1500, advance: { onClick: false, afterMs: 3000 } })
	})

	it("gives every layout pair in use a synthetic layout under its master, with the page layout's placeholders", async () => {
		const opened = await openOdpFixture({
			styles: '<style:presentation-page-layout style:name="AL1T1"><presentation:placeholder presentation:object="title" svg:x="10%" svg:y="1cm" svg:width="80%" svg:height="2cm"/><presentation:placeholder presentation:object="outline" svg:x="1cm" svg:y="4cm" svg:width="20cm" svg:height="10cm"/></style:presentation-page-layout>',
			body:
				page("", 'draw:master-page-name="M" presentation:presentation-page-layout-name="AL1T1"') +
				page("", 'draw:master-page-name="M" presentation:presentation-page-layout-name="AL1T1"')
		})
		const slide = await slideOf(opened, 0)
		const layout = slide.parent === undefined ? undefined : opened.deck.nodes.get(slide.parent)

		expect(opened.deck.layouts).toHaveLength(1)
		expect(layout).toMatchObject({ kind: "layout", synthetic: true, parent: opened.deck.masters[0] })
		expect(layout?.shapes.map(shape => [shape.ph?.type, shape.xfrm?.x])).toEqual([
			["title", Math.round(2.8 * EMU_PER_CM)],
			["body", EMU_PER_CM]
		])
		expect(opened.deck.nodes.get(opened.deck.masters[0] ?? slide.ref)?.background).toMatchObject({
			kind: "fill",
			fill: { kind: "solid" }
		})
	})
})
