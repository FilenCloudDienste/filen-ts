import { describe, expect, it } from "vitest"
import { PropsReader, PropsStore, parseUniversalMeasure, propertyChangeNode } from "../core/docx/props/index"
import { W, W_STRICT, find, wordPart, xml } from "./docxFixtures"

function runProps(inner: string, w?: string): ReturnType<PropsStore["run"]> {
	const document = wordPart("document", `<w:body><w:p><w:r><w:rPr>${inner}</w:rPr></w:r></w:p></w:body>`, w)

	return new PropsStore().run(document, find(document, "w:rPr"))
}

function paragraphProps(inner: string, w?: string): ReturnType<PropsStore["paragraph"]> {
	const document = wordPart("document", `<w:body><w:p><w:pPr>${inner}</w:pPr></w:p></w:body>`, w)

	return new PropsStore().paragraph(document, find(document, "w:pPr"))
}

describe("run properties", () => {
	it("reads fonts with theme slots and hint", () => {
		const props = runProps(
			'<w:rFonts w:ascii="Arial" w:hAnsi="Arial &amp; Co" w:eastAsia="MS Mincho" w:cs="Arial" w:asciiTheme="minorHAnsi" w:cstheme="minorBidi" w:hint="eastAsia"/>'
		)

		expect(props.fonts).toEqual({
			ascii: "Arial",
			hAnsi: "Arial & Co",
			eastAsia: "MS Mincho",
			cs: "Arial",
			asciiTheme: "minorHAnsi",
			csTheme: "minorBidi",
			hint: "eastAsia"
		})
	})

	it("reads toggles as written, including explicit off in every ST_OnOff spelling", () => {
		const props = runProps(
			'<w:b/><w:bCs w:val="0"/><w:i w:val="true"/><w:iCs w:val="false"/><w:caps w:val="on"/><w:smallCaps w:val="off"/>' +
				'<w:strike w:val="1"/><w:dstrike/><w:outline/><w:shadow/><w:emboss/><w:imprint/><w:vanish/><w:specVanish/><w:webHidden/>' +
				'<w:noProof/><w:snapToGrid w:val="0"/><w:rtl/><w:cs/><w:oMath/>'
		)

		expect(props).toMatchObject({
			bold: true,
			boldCs: false,
			italic: true,
			italicCs: false,
			caps: true,
			smallCaps: false,
			strike: true,
			doubleStrike: true,
			outline: true,
			shadow: true,
			emboss: true,
			imprint: true,
			vanish: true,
			specVanish: true,
			webHidden: true,
			noProof: true,
			snapToGrid: false,
			rtl: true,
			cs: true,
			oMath: true
		})
	})

	it("reads colours, sizes, spacing, underline, highlight and the rest", () => {
		const props = runProps(
			'<w:rStyle w:val="Strong"/><w:color w:val="1f3864" w:themeColor="accent1" w:themeShade="BF"/><w:spacing w:val="-10"/><w:w w:val="90"/>' +
				'<w:kern w:val="28"/><w:position w:val="-6"/><w:sz w:val="28"/><w:szCs w:val="24"/><w:highlight w:val="yellow"/>' +
				'<w:u w:val="double" w:color="FF0000" w:themeColor="accent2"/><w:effect w:val="blinkBackground"/>' +
				'<w:bdr w:val="single" w:sz="4" w:space="1" w:color="auto"/><w:shd w:val="pct25" w:color="auto" w:fill="FFFF00" w:themeFill="accent4" w:themeFillTint="66"/>' +
				'<w:fitText w:val="1440" w:id="7"/><w:vertAlign w:val="superscript"/><w:em w:val="dot"/>' +
				'<w:lang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"/><w:eastAsianLayout w:id="3" w:combine="1" w:combineBrackets="round" w:vert="0"/>'
		)

		expect(props).toEqual({
			styleId: "Strong",
			color: { val: "1F3864", themeColor: "accent1", themeShade: 191 },
			spacing: -10,
			scale: 90,
			kern: 28,
			position: -6,
			size: 28,
			sizeCs: 24,
			highlight: "yellow",
			underline: { style: "double", val: "FF0000", themeColor: "accent2" },
			effect: "blinkBackground",
			border: { style: "single", size: 4, space: 1, val: "auto" },
			shading: { pattern: "pct25", color: { val: "auto" }, fill: { val: "FFFF00", themeColor: "accent4", themeTint: 102 } },
			fitText: { width: 1440, id: 7 },
			vertAlign: "superscript",
			emphasis: "dot",
			lang: { latin: "en-US", eastAsia: "ja-JP", bidi: "ar-SA" },
			eastAsianLayout: { id: 3, combine: true, combineBrackets: "round", vertical: false }
		})
	})

	it("converts universal measures (Strict and transitional 2nd edition)", () => {
		const props = runProps('<w:sz w:val="12pt"/><w:spacing w:val="0.5pt"/><w:w w:val="150%"/><w:position w:val="-1.5pt"/>')

		expect(props).toMatchObject({ size: 24, spacing: 10, scale: 150, position: -3 })
		expect(parseUniversalMeasure("1in", 20)).toBe(1440)
		expect(parseUniversalMeasure("2.54cm", 20)).toBe(1440)
		expect(parseUniversalMeasure("10mm", 20)).toBe(567)
		expect(parseUniversalMeasure("1pc", 20)).toBe(240)
		expect(parseUniversalMeasure("1pi", 2)).toBe(24)
		expect(parseUniversalMeasure("12", 20)).toBeUndefined()
	})

	it("keeps paragraph-mark revisions and the tracked change with its previous properties", () => {
		const props = runProps(
			'<w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/><w:b/>' +
				'<w:rPrChange w:id="2" w:author="B" w:date="2024-01-02T00:00:00Z"><w:rPr><w:i/><w:sz w:val="20"/></w:rPr></w:rPrChange>'
		)

		expect(props.revisions).toEqual([{ kind: "ins", id: 1, author: "A", date: "2024-01-01T00:00:00Z" }])
		expect(props.change).toEqual({ id: 2, author: "B", date: "2024-01-02T00:00:00Z", previous: { italic: true, size: 20 } })
	})

	it("ignores elements of other namespaces and unknown values", () => {
		const document = xml(
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">' +
				'<w:rPr><w14:textOutline w14:w="9525"/><w14:b/><w:vertAlign w:val="sideways"/><w:color w:val="nonsense"/><w:sz w:val="0"/></w:rPr></w:document>'
		)

		expect(new PropsStore().run(document, find(document, "w:rPr"))).toEqual({})
	})

	it("reads Strict OOXML and generator-chosen prefixes", () => {
		expect(runProps('<w:b/><w:sz w:val="24"/>', W_STRICT)).toEqual({ bold: true, size: 24 })

		const document = xml(
			'<ns0:document xmlns:ns0="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><ns0:rPr><ns0:i/><ns0:sz ns0:val="30"/></ns0:rPr></ns0:document>'
		)

		expect(new PropsStore().run(document, find(document, "ns0:rPr"))).toEqual({ italic: true, size: 30 })
	})

	it("resolves namespaces declared below the root", () => {
		const document = xml(
			'<root><x:rPr xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:caps/></x:rPr>' +
				'<y:rPr xmlns:y="urn:other"><y:caps/></y:rPr></root>'
		)

		expect(new PropsStore().run(document, find(document, "x:rPr"))).toEqual({ caps: true })
		expect(new PropsStore().run(document, find(document, "y:rPr"))).toEqual({})
	})
})

describe("paragraph properties", () => {
	it("drops firstLine when w:ind also gives hanging", () => {
		expect(paragraphProps('<w:ind w:left="1440" w:firstLine="720" w:hanging="720"/>').indent).toEqual({ start: 1440, hanging: 720 })
		expect(paragraphProps('<w:ind w:firstLineChars="100" w:hangingChars="200"/>').indent).toEqual({ hangingChars: 200 })
		expect(paragraphProps('<w:ind w:firstLine="720" w:hangingChars="200"/>').indent).toEqual({ firstLine: 720, hangingChars: 200 })
	})

	it("reads layout properties", () => {
		const props = paragraphProps(
			'<w:pStyle w:val="Heading1"/><w:keepNext/><w:keepLines/><w:pageBreakBefore w:val="0"/><w:widowControl w:val="0"/>' +
				'<w:numPr><w:ilvl w:val="1"/><w:numId w:val="4"/></w:numPr><w:suppressLineNumbers/>' +
				'<w:pBdr><w:top w:val="single" w:sz="8" w:space="1" w:color="4472C4"/><w:left w:val="dotted"/><w:right w:val="dashed"/><w:between w:val="single"/><w:bar w:val="single"/></w:pBdr>' +
				'<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' +
				'<w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="decimal" w:leader="dot" w:pos="5000"/><w:tab w:val="clear" w:pos="1440"/></w:tabs>' +
				'<w:suppressAutoHyphens/><w:kinsoku w:val="0"/><w:wordWrap w:val="0"/><w:overflowPunct w:val="0"/><w:topLinePunct/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/>' +
				'<w:bidi/><w:adjustRightInd w:val="0"/><w:snapToGrid w:val="0"/>' +
				'<w:spacing w:before="240" w:beforeLines="100" w:beforeAutospacing="1" w:after="120" w:afterAutospacing="0" w:line="276" w:lineRule="auto"/>' +
				'<w:ind w:left="720" w:leftChars="200" w:right="360" w:hanging="360" w:firstLineChars="0"/>' +
				'<w:contextualSpacing/><w:mirrorIndents/><w:suppressOverlap/><w:jc w:val="both"/><w:textDirection w:val="tbRl"/><w:textAlignment w:val="center"/>' +
				'<w:outlineLvl w:val="0"/><w:divId w:val="12345"/><w:cnfStyle w:val="100000000000"/>' +
				'<w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text" w:x="100" w:y="-20" w:hRule="exact" w:h="400"/>' +
				"<w:rPr><w:b/></w:rPr><w:sectPr/>"
		)

		expect(props).toEqual({
			styleId: "Heading1",
			keepNext: true,
			keepLines: true,
			pageBreakBefore: false,
			widowControl: false,
			numbering: { ilvl: 1, numId: 4 },
			suppressLineNumbers: true,
			borders: {
				top: { style: "single", size: 8, space: 1, val: "4472C4" },
				start: { style: "dotted" },
				end: { style: "dashed" },
				between: { style: "single" },
				bar: { style: "single" }
			},
			shading: { pattern: "clear", color: { val: "auto" }, fill: { val: "D9E2F3" } },
			tabs: [
				{ alignment: "left", position: 720 },
				{ alignment: "decimal", position: 5000, leader: "dot" },
				{ alignment: "clear", position: 1440 }
			],
			suppressAutoHyphens: true,
			kinsoku: false,
			wordWrap: false,
			overflowPunct: false,
			topLinePunct: true,
			autoSpaceDE: false,
			autoSpaceDN: false,
			bidi: true,
			adjustRightInd: false,
			snapToGrid: false,
			spacing: {
				before: 240,
				beforeLines: 100,
				beforeAutospacing: true,
				after: 120,
				afterAutospacing: false,
				line: 276,
				lineRule: "auto"
			},
			indent: { start: 720, startChars: 200, end: 360, hanging: 360, firstLineChars: 0 },
			contextualSpacing: true,
			mirrorIndents: true,
			suppressOverlap: true,
			alignment: "both",
			textDirection: "tbRl",
			textAlignment: "center",
			outlineLevel: 0,
			divId: 12345,
			conditional: { firstRow: true },
			frame: {
				dropCap: "drop",
				lines: 3,
				wrap: "around",
				vAnchor: "text",
				hAnchor: "text",
				x: 100,
				y: -20,
				hRule: "exact",
				height: 400
			},
			markRun: { bold: true },
			hasSection: true
		})
	})

	it("reads Strict start/end indents and alignment", () => {
		expect(paragraphProps('<w:ind w:start="1in" w:end="0.5in" w:firstLine="360"/><w:jc w:val="end"/>', W_STRICT)).toEqual({
			indent: { start: 1440, end: 720, firstLine: 360 },
			alignment: "end"
		})
	})

	it("reads cnfStyle written as attributes and pPrChange", () => {
		const props = paragraphProps(
			'<w:cnfStyle w:firstRow="0" w:lastColumn="1" w:oddHBand="1"/><w:jc w:val="center"/>' +
				'<w:pPrChange w:id="5" w:author="X"><w:pPr><w:jc w:val="left"/><w:ind w:left="100"/></w:pPr></w:pPrChange>'
		)

		expect(props.conditional).toEqual({ lastColumn: true, oddHBand: true })
		// A flag's attribute wins over its bit in w:val.
		expect(paragraphProps('<w:cnfStyle w:val="100000000000" w:firstRow="0" w:lastRow="1"/>').conditional).toEqual({ lastRow: true })
		expect(paragraphProps('<w:cnfStyle w:val="010000000001"/>').conditional).toEqual({ lastRow: true, lastRowLastColumn: true })
		expect(props.change).toEqual({ id: 5, author: "X", previous: { alignment: "left", indent: { start: 100 } } })
	})
})

describe("table, row and cell properties", () => {
	it("reads w:tblPr including floating position, borders, margins and look", () => {
		const document = wordPart(
			"document",
			'<w:tbl><w:tblPr><w:tblStyle w:val="GridTable4"/><w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="page" w:horzAnchor="margin" w:tblpXSpec="center" w:tblpY="2000"/>' +
				'<w:tblOverlap w:val="never"/><w:bidiVisual/><w:tblStyleRowBandSize w:val="2"/><w:tblStyleColBandSize w:val="3"/><w:tblW w:w="5000" w:type="pct"/>' +
				'<w:jc w:val="center"/><w:tblCellSpacing w:w="20" w:type="dxa"/><w:tblInd w:w="108" w:type="dxa"/>' +
				'<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="nil"/><w:start w:val="double"/></w:tblBorders>' +
				'<w:shd w:val="clear" w:fill="EEEEEE"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="0.1in" w:type="dxa"/></w:tblCellMar>' +
				'<w:tblLook w:val="04A0"/><w:tblCaption w:val="Caption"/><w:tblDescription w:val="Desc"/></w:tblPr></w:tbl>'
		)

		expect(new PropsStore().table(document, find(document, "w:tblPr"))).toEqual({
			styleId: "GridTable4",
			position: { leftFromText: 180, rightFromText: 180, y: 2000, vertAnchor: "page", horzAnchor: "margin", xSpec: "center" },
			overlap: "never",
			bidiVisual: true,
			rowBandSize: 2,
			colBandSize: 3,
			width: { value: 5000, type: "pct" },
			alignment: "center",
			cellSpacing: { value: 20, type: "dxa" },
			indent: { value: 108, type: "dxa" },
			borders: { top: { style: "single", size: 4, space: 0, val: "auto" }, insideH: { style: "nil" }, start: { style: "double" } },
			shading: { pattern: "clear", fill: { val: "EEEEEE" } },
			layout: "fixed",
			cellMargins: { start: { value: 108, type: "dxa" }, end: { value: 144, type: "dxa" } },
			look: { firstRow: true, lastRow: false, firstColumn: true, lastColumn: false, noHBand: false, noVBand: true },
			caption: "Caption",
			description: "Desc"
		})
	})

	it("reads tblLook attributes, Strict percentage widths and tblPrEx", () => {
		const document = wordPart(
			"document",
			'<w:tblPr><w:tblW w:w="50%" w:type="pct"/><w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="1" w:noHBand="1" w:noVBand="0"/></w:tblPr>' +
				'<w:tblPrEx><w:tblBorders><w:bottom w:val="thick"/></w:tblBorders></w:tblPrEx>',
			W_STRICT
		)
		const store = new PropsStore()

		expect(store.table(document, find(document, "w:tblPr"))).toEqual({
			width: { value: 2500, type: "pct" },
			look: { firstRow: true, lastRow: false, firstColumn: false, lastColumn: true, noHBand: true, noVBand: false }
		})
		expect(store.table(document, find(document, "w:tblPrEx"))).toEqual({ borders: { bottom: { style: "thick" } } })
	})

	it("reads w:val only when tblLook has no attributes, missing attributes taking the §17.4.55 defaults", () => {
		const document = wordPart(
			"document",
			'<w:tblPr><w:tblLook w:val="04A0" w:firstRow="0"/></w:tblPr><w:tblPr><w:tblLook w:val="0000"/></w:tblPr><w:tblPr><w:tblLook/></w:tblPr>'
		)
		const store = new PropsStore()
		const looks = [0, 1, 2].map(k => {
			let node = -1

			for (let n = 0; n <= k; n++) node = find(document, "w:tblPr", node + 1)

			return store.table(document, node).look
		})

		const none = { firstRow: false, lastRow: false, firstColumn: false, lastColumn: false, noHBand: false, noVBand: false }

		// The attribute form ignores w:val; banding stays on and the edge regions off.
		expect(looks[0]).toEqual(none)
		expect(looks[1]).toEqual(none)
		expect(looks[2]).toEqual(none)
	})

	it("reads w:trPr", () => {
		const document = wordPart(
			"document",
			'<w:trPr><w:cnfStyle w:val="000000100000"/><w:gridBefore w:val="1"/><w:gridAfter w:val="2"/><w:wBefore w:w="500" w:type="dxa"/>' +
				'<w:wAfter w:w="0" w:type="auto"/><w:cantSplit/><w:trHeight w:val="400" w:hRule="exact"/><w:tblHeader/><w:jc w:val="right"/><w:hidden/>' +
				'<w:del w:id="9" w:author="Z"/><w:trPrChange w:id="10"><w:trPr><w:cantSplit w:val="0"/></w:trPr></w:trPrChange></w:trPr>'
		)

		expect(new PropsStore().row(document, find(document, "w:trPr"))).toEqual({
			conditional: { oddHBand: true },
			gridBefore: 1,
			gridAfter: 2,
			widthBefore: { value: 500, type: "dxa" },
			widthAfter: { value: 0, type: "auto" },
			cantSplit: true,
			height: { value: 400, rule: "exact" },
			header: true,
			alignment: "right",
			hidden: true,
			revisions: [{ kind: "del", id: 9, author: "Z" }],
			change: { id: 10, previous: { cantSplit: false } }
		})
	})

	it("reads w:tcPr", () => {
		const document = wordPart(
			"document",
			'<w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:gridSpan w:val="2"/><w:hMerge w:val="restart"/><w:vMerge/>' +
				'<w:tcBorders><w:top w:val="nil"/><w:right w:val="single"/><w:tl2br w:val="single"/><w:insideV w:val="dotted"/></w:tcBorders>' +
				'<w:shd w:val="solid" w:color="FF0000"/><w:noWrap/><w:tcMar><w:top w:w="50" w:type="dxa"/><w:end w:w="10" w:type="dxa"/></w:tcMar>' +
				'<w:textDirection w:val="btLr"/><w:tcFitText/><w:vAlign w:val="center"/><w:hideMark/><w:cellIns w:id="3"/><w:cellMerge w:id="4"/></w:tcPr>'
		)

		expect(new PropsStore().cell(document, find(document, "w:tcPr"))).toEqual({
			width: { value: 2000, type: "dxa" },
			gridSpan: 2,
			hMerge: "restart",
			vMerge: "continue",
			borders: { top: { style: "nil" }, end: { style: "single" }, tl2br: { style: "single" }, insideV: { style: "dotted" } },
			shading: { pattern: "solid", color: { val: "FF0000" } },
			noWrap: true,
			margins: { top: { value: 50, type: "dxa" }, end: { value: 10, type: "dxa" } },
			textDirection: "btLr",
			fitText: true,
			vAlign: "center",
			hideMark: true,
			revisions: [
				{ kind: "ins", id: 3 },
				{ kind: "merge", id: 4 }
			]
		})
	})
})

describe("section properties", () => {
	it("reads w:sectPr", () => {
		const document = wordPart(
			"document",
			'<w:sectPr><w:headerReference w:type="default" r:id="rId8"/><w:headerReference w:type="first" r:id="rId9"/><w:footerReference w:type="even" r:id="rId10"/>' +
				'<w:footnotePr><w:pos w:val="beneathText"/><w:numFmt w:val="lowerRoman"/><w:numStart w:val="3"/><w:numRestart w:val="eachPage"/></w:footnotePr>' +
				'<w:endnotePr><w:numFmt w:val="upperLetter"/></w:endnotePr><w:type w:val="continuous"/>' +
				'<w:pgSz w:w="16838" w:h="11906" w:orient="landscape" w:code="9"/><w:pgMar w:top="-1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="708" w:footer="708" w:gutter="0"/>' +
				'<w:pgBorders w:offsetFrom="page" w:display="firstPage"><w:top w:val="single" w:sz="4" w:space="24"/></w:pgBorders>' +
				'<w:lnNumType w:countBy="5" w:start="1" w:distance="360" w:restart="newSection"/><w:pgNumType w:fmt="lowerRoman" w:start="4" w:chapStyle="1" w:chapSep="emDash"/>' +
				'<w:cols w:num="2" w:space="720" w:equalWidth="0" w:sep="1"><w:col w:w="4000" w:space="500"/><w:col w:w="5000"/></w:cols>' +
				'<w:formProt w:val="0"/><w:vAlign w:val="center"/><w:noEndnote/><w:titlePg/><w:textDirection w:val="lrTb"/><w:bidi/><w:rtlGutter/>' +
				'<w:docGrid w:type="lines" w:linePitch="360" w:charSpace="-2048"/><w:printerSettings r:id="rId11"/></w:sectPr>'
		)

		expect(new PropsStore().section(document, find(document, "w:sectPr"))).toEqual({
			headers: [
				{ type: "default", relationshipId: "rId8" },
				{ type: "first", relationshipId: "rId9" }
			],
			footers: [{ type: "even", relationshipId: "rId10" }],
			footnotes: { position: "beneathText", numFormat: "lowerRoman", numStart: 3, numRestart: "eachPage" },
			endnotes: { numFormat: "upperLetter" },
			type: "continuous",
			pageSize: { width: 16838, height: 11906, orient: "landscape", code: 9 },
			pageMargins: { top: -1440, right: 1080, bottom: 1440, left: 1080, header: 708, footer: 708, gutter: 0 },
			pageBorders: { offsetFrom: "page", display: "firstPage", top: { style: "single", size: 4, space: 24 } },
			lineNumbering: { countBy: 5, start: 1, distance: 360, restart: "newSection" },
			pageNumbering: { format: "lowerRoman", start: 4, chapterStyle: 1, chapterSeparator: "emDash" },
			columns: { count: 2, space: 720, equalWidth: false, separator: true, columns: [{ width: 4000, space: 500 }, { width: 5000 }] },
			formProtection: false,
			vAlign: "center",
			noEndnote: true,
			titlePage: true,
			textDirection: "lrTb",
			bidi: true,
			rtlGutter: true,
			docGrid: { type: "lines", linePitch: 360, charSpace: -2048 },
			printerSettings: "rId11"
		})
	})

	it("reads Strict relationship ids", () => {
		const document = xml(
			'<w:sectPr xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>'
		)

		expect(new PropsStore().section(document, document.documentElement()).headers).toEqual([
			{ type: "default", relationshipId: "rId1" }
		])
	})
})

describe("interning", () => {
	it("returns one object for byte-identical containers across nodes and parts, and the empty object for none", () => {
		const a = wordPart(
			"document",
			'<w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:r><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:r><w:r><w:rPr><w:i/></w:rPr></w:r>'
		)
		const b = wordPart("styles", '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:rPr/>')
		const store = new PropsStore()
		const [first, second, third] = [find(a, "w:rPr"), find(a, "w:rPr", find(a, "w:rPr") + 1), find(a, "w:i") - 1]
		const one = store.run(a, first)

		expect(store.run(a, second)).toBe(one)
		expect(store.run(b, find(b, "w:rPr"))).toBe(one)
		expect(store.run(a, third)).not.toBe(one)
		expect(store.run(b, find(b, "w:rPr", find(b, "w:sz")))).toBe(store.run(a, -1))
		expect(store.stats().runs).toBe(2)
	})

	it("does not share between parts whose prefix binds another namespace", () => {
		const transitional = wordPart("document", "<w:rPr><w:b/></w:rPr>")
		const strict = wordPart("document", "<w:rPr><w:b/></w:rPr>", W_STRICT)
		const store = new PropsStore()

		expect(store.run(transitional, find(transitional, "w:rPr"))).toEqual(store.run(strict, find(strict, "w:rPr")))
		expect(store.stats().runs).toBe(2)
	})
})

describe("raw references", () => {
	it("finds the tracked change element for the writer", () => {
		const document = wordPart(
			"document",
			'<w:pPr><w:jc w:val="center"/><w:pPrChange w:id="1"><w:pPr/></w:pPrChange></w:pPr><w:rPr><w:b/></w:rPr>'
		)
		const reader = PropsReader.for(document)

		expect(propertyChangeNode(reader, find(document, "w:pPr"))).toBe(find(document, "w:pPrChange"))
		expect(propertyChangeNode(reader, find(document, "w:rPr", find(document, "w:pPrChange") + 2))).toBe(-1)
	})
})

describe("hostile and malformed input", () => {
	it("clamps integers and lengths to int32", () => {
		const props = paragraphProps(
			'<w:spacing w:before="99999999999" w:after="-99999999999"/><w:outlineLvl w:val="1e3"/><w:divId w:val="4294967296"/>'
		)

		expect(props.spacing).toEqual({ before: 2147483647, after: -2147483648 })
		expect(props.outlineLevel).toBeUndefined()
		expect(props.divId).toBe(2147483647)
	})

	it("reads a malformed container as empty, reports it once, and never throws", () => {
		const document = xml(
			`<w:document xmlns:w="${W}"><w:rPr><w:b/><w:sz w:val="24" w:val="26"/></w:rPr><w:rPr><w:b/><w:sz w:val="24" w:val="26"/></w:rPr>` +
				"<w:pPr><w:jc w:val=center/></w:pPr><w:rPr><w:i/></w:rPr></w:document>"
		)
		const store = new PropsStore()
		const first = find(document, "w:rPr")

		expect(store.run(document, first)).toEqual({})
		expect(store.run(document, find(document, "w:rPr", first + 1))).toEqual({})
		expect(store.paragraph(document, find(document, "w:pPr"))).toEqual({})
		expect(store.run(document, find(document, "w:rPr", find(document, "w:pPr")))).toEqual({ italic: true })
		expect(store.malformed.map(ref => ref.node)).toEqual([first, find(document, "w:pPr")])
	})

	it("reads parts whose namespace declarations are malformed", () => {
		const document = xml(
			`<w:document xmlns:w="${W}"><w:body><w:p xmlns:x="urn:a" xmlns:x="urn:b"><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:body></w:document>`
		)

		expect(new PropsStore().paragraph(document, find(document, "w:pPr"))).toEqual({ alignment: "center" })
	})

	it("keeps no view of the part's buffer and freezes the shared empty objects", () => {
		const document = wordPart("document", "<w:rPr><w:b/></w:rPr>")
		const store = new PropsStore()
		const empty = store.run(document, -1)

		store.run(document, find(document, "w:rPr"))

		const entries = [...(store as unknown as { runs: { buckets: Map<number, { bytes: Uint8Array }[]> } }).runs.buckets.values()].flat()

		expect(entries.every(entry => entry.bytes.buffer !== document.bytes.buffer)).toBe(true)
		expect(Object.isFrozen(empty)).toBe(true)
		expect(Object.isFrozen(store.paragraph(document, -1))).toBe(true)
	})
})
