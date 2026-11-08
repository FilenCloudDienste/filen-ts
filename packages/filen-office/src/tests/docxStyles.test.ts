import { describe, expect, it } from "vitest"
import { parseNumbering } from "../core/docx/numbering/index"
import { PropsStore, type ParagraphProps, type RunProps, type TableCellProps, type TableProps } from "../core/docx/props/index"
import {
	CONDITION_ORDER,
	DEFAULT_TABLE_LOOK,
	PropertyResolver,
	cellConditions,
	conditionBit,
	headingLevel,
	MAX_STYLE_DEPTH,
	parseStyles,
	readStyleSettings,
	resolveSection,
	type DocxStyles
} from "../core/docx/styles/index"
import { parseTheme } from "../core/docx/theme/index"
import type { XmlDocument } from "../core/xml/index"
import { OFFICE_THEME, W, find, stylesXml, wordPart, xml } from "./docxFixtures"
import { budget } from "./timing"

interface Fixture {
	readonly store: PropsStore
	readonly styles: DocxStyles
	readonly resolver: PropertyResolver
	readonly document: XmlDocument
	run(inner: string): RunProps
	paragraph(inner: string): ParagraphProps
	table(inner: string): TableProps
	cell(inner: string): TableCellProps
}

// Styles (and optionally numbering) plus a scratch document whose containers are parsed on request.
function fixture(stylesBody: string, defaults: string = "", numberingBody?: string, settings?: string): Fixture {
	const store = new PropsStore()
	const styles = parseStyles(stylesXml(stylesBody, defaults), store)
	const numbering = numberingBody === undefined ? undefined : parseNumbering(wordPart("numbering", numberingBody), store, styles)
	const resolver = new PropertyResolver({
		styles,
		numbering,
		theme: parseTheme(OFFICE_THEME),
		settings: settings === undefined ? undefined : readStyleSettings(xml(`<w:settings xmlns:w="${W}">${settings}</w:settings>`))
	})
	const parse = <T>(element: string, inner: string, read: (document: XmlDocument, node: number) => T): T => {
		const document = wordPart("document", `<w:${element}>${inner}</w:${element}>`)

		return read(document, find(document, `w:${element}`))
	}

	return {
		store,
		styles,
		resolver,
		document: wordPart("document", ""),
		run: inner => parse("rPr", inner, (d, n) => store.run(d, n)),
		paragraph: inner => parse("pPr", inner, (d, n) => store.paragraph(d, n)),
		table: inner => parse("tblPr", inner, (d, n) => store.table(d, n)),
		cell: inner => parse("tcPr", inner, (d, n) => store.cell(d, n))
	}
}

const NORMAL = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
const DEFAULT_FONT =
	'<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>'

describe("styles part", () => {
	const styles = parseStyles(
		stylesXml(
			NORMAL +
				DEFAULT_FONT +
				'<w:latentStyles w:defLockedState="0" w:defUIPriority="99" w:defSemiHidden="0" w:count="376"><w:lsdException w:name="heading 2" w:uiPriority="9" w:qFormat="1"/><w:lsdException w:name="Normal" w:qFormat="1"/></w:latentStyles>' +
				'<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="berschrift1Zchn"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
				'<w:style w:type="character" w:customStyle="1" w:styleId="berschrift1Zchn"><w:name w:val="Überschrift 1 Zchn"/><w:aliases w:val="H1 Char, Kopf"/><w:link w:val="berschrift1"/><w:rPr><w:b/></w:rPr></w:style>' +
				'<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
				'<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Duplicate"/></w:style>',
			'<w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault>'
		),
		new PropsStore()
	)

	it("reads document defaults, definitions and latent styles", () => {
		expect(styles.defaultRun).toEqual({ size: 22 })
		expect(styles.defaultParagraph).toEqual({ spacing: { after: 160 } })
		expect(styles.styles).toHaveLength(6)
		expect(styles.byId("Normal")?.name).toBe("Normal")
		expect(styles.defaultOf("paragraph")?.id).toBe("Normal")
		expect(styles.defaultOf("character")?.id).toBe("DefaultParagraphFont")
		expect(styles.defaultOf("table")?.semiHidden).toBe(true)
		expect(styles.defaultOf("numbering")).toBeUndefined()
		expect(styles.latent.defaultUiPriority).toBe(99)
		expect(styles.latent.count).toBe(376)
		expect(styles.latent.exceptions.get("heading 2")).toMatchObject({ name: "heading 2", uiPriority: 9, quickFormat: true })
	})

	it("finds styles by canonical name whatever the localised id, and by alias", () => {
		const heading = styles.byName("Heading 1")

		expect(heading?.id).toBe("berschrift1")
		expect(heading && headingLevel(heading)).toBe(1)
		expect(heading).toMatchObject({ basedOn: "Normal", next: "Normal", link: "berschrift1Zchn", uiPriority: 9, quickFormat: true })
		expect(styles.byName("h1 char")?.id).toBe("berschrift1Zchn")
		expect(styles.byName("heading 1", "character")).toBeUndefined()
		expect(styles.byName("normal table", "table")?.id).toBe("TableNormal")
		expect(styles.byId("BERSCHRIFT1")?.id).toBe("berschrift1")
		expect(styles.isLatentOnly("Heading 2")).toBe(true)
		expect(styles.isLatentOnly("Normal")).toBe(false)
	})

	it("walks basedOn chains, ignoring missing styles and other types, cutting cycles at a fixed member", () => {
		const body =
			'<w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/><w:rPr><w:sz w:val="10"/></w:rPr></w:style>' +
			'<w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="C"/><w:rPr><w:sz w:val="12"/><w:i/></w:rPr></w:style>' +
			'<w:style w:type="paragraph" w:styleId="C"><w:basedOn w:val="A"/><w:rPr><w:sz w:val="14"/><w:caps/><w:i w:val="0"/></w:rPr></w:style>' +
			'<w:style w:type="paragraph" w:styleId="D"><w:basedOn w:val="Missing"/></w:style>' +
			'<w:style w:type="paragraph" w:styleId="E"><w:basedOn w:val="F"/></w:style>' +
			'<w:style w:type="character" w:styleId="F"/>'
		const forward = fixture(body)
		const backward = fixture(body)
		const ids = (resolver: PropertyResolver, id: string): string[] =>
			resolver.styles.chain(resolver.styles.byId(id) ?? resolver.styles.styles[0]!).map(style => style.id)

		// The cycle A -> B -> C -> A is cut at its lowest-index member, A, whichever style is resolved first.
		expect(ids(forward.resolver, "A")).toEqual(["A"])
		expect(ids(forward.resolver, "B")).toEqual(["A", "C", "B"])
		expect(ids(forward.resolver, "C")).toEqual(["A", "C"])
		expect(ids(forward.resolver, "D")).toEqual(["D"])
		expect(ids(forward.resolver, "E")).toEqual(["E"])

		const resolveAll = (f: Fixture, order: readonly string[]): Record<string, unknown> => {
			const out: Record<string, unknown> = {}

			for (const id of order) {
				const props = f.resolver.run(f.resolver.paragraph(f.paragraph(`<w:pStyle w:val="${id}"/>`)), f.run(""))

				out[id] = { size: props.size, italic: props.italic, caps: props.caps }
			}

			return out
		}

		expect(resolveAll(forward, ["A", "B", "C"])).toEqual(resolveAll(backward, ["C", "B", "A"]))
		expect(resolveAll(forward, ["B"])).toEqual({ B: { size: 12, italic: true, caps: true } })
	})

	it("flattens deep basedOn chains linearly and caps their depth", () => {
		let body = ""

		for (let k = 0; k < 3000; k++) {
			body += `<w:style w:type="paragraph" w:styleId="S${k}">${k > 0 ? `<w:basedOn w:val="S${k - 1}"/>` : ""}<w:pPr><w:spacing w:after="${k}"/></w:pPr><w:rPr><w:sz w:val="${(k % 50) + 10}"/><w:b/></w:rPr></w:style>`
		}

		const f = fixture(body)
		const started = performance.now()

		for (let k = 0; k < 3000; k++) f.resolver.run(f.resolver.paragraph(f.paragraph(`<w:pStyle w:val="S${k}"/>`)), f.run(""))

		// Linear work: well under a second even on slow machines (quadratic flattening took tens of seconds).
		expect(performance.now() - started).toBeLessThan(budget(5000))

		const deepest = f.styles.byId("S2999")

		expect(deepest && f.styles.chain(deepest).length).toBeLessThanOrEqual(MAX_STYLE_DEPTH)
		expect(deepest && f.styles.chain(deepest)[0]?.id).toBe(`S${2999 - (2999 % MAX_STYLE_DEPTH)}`)
	})
})

describe("run resolution", () => {
	it("applies document defaults, paragraph style, character style and direct formatting in order", () => {
		const f = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="Body"><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="24"/><w:color w:val="333333"/></w:rPr></w:style>' +
				'<w:style w:type="character" w:styleId="Emph"><w:rPr><w:color w:val="FF0000"/><w:spacing w:val="20"/></w:rPr></w:style>',
			'<w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault>'
		)
		const paragraph = f.resolver.paragraph(f.paragraph('<w:pStyle w:val="Body"/>'))
		const plain = f.resolver.run(paragraph, f.run(""))
		const styled = f.resolver.run(paragraph, f.run('<w:rStyle w:val="Emph"/><w:spacing w:val="-5"/>'))

		expect(plain).toMatchObject({ size: 24, color: "333333", spacing: 0, styleId: undefined })
		// Unset slots are Times New Roman; that eastAsia default with ascii = hAnsi draws East Asian text in Georgia.
		expect(plain.fonts).toEqual({
			ascii: "Georgia",
			hAnsi: "Georgia",
			eastAsia: "Times New Roman",
			cs: "Times New Roman",
			hint: "default",
			eastAsiaUsesAscii: true
		})
		expect(plain.lang).toEqual({ latin: "de-DE", eastAsia: undefined, bidi: undefined })
		expect(styled).toMatchObject({ size: 24, color: "FF0000", spacing: -5, styleId: "Emph" })
	})

	it("combines toggle properties by XOR across style levels and sets them absolutely in direct formatting", () => {
		const f = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="BoldPara"><w:rPr><w:b/><w:i/><w:caps w:val="0"/></w:rPr></w:style>' +
				'<w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="BoldPara"/><w:rPr><w:b w:val="0"/></w:rPr></w:style>' +
				'<w:style w:type="character" w:styleId="Strong"><w:rPr><w:b/><w:caps/><w:i w:val="0"/></w:rPr></w:style>'
		)
		const bold = f.resolver.paragraph(f.paragraph('<w:pStyle w:val="BoldPara"/>'))
		const derived = f.resolver.paragraph(f.paragraph('<w:pStyle w:val="Derived"/>'))
		const run = (paragraph: ReturnType<PropertyResolver["paragraph"]>, inner: string): Record<string, boolean> => {
			const props = f.resolver.run(paragraph, f.run(inner))

			return { bold: props.bold, italic: props.italic, caps: props.caps }
		}

		expect(run(bold, "")).toEqual({ bold: true, italic: true, caps: false })
		// Bold in the paragraph style and in the character style cancel; "off" in a style changes nothing.
		expect(run(bold, '<w:rStyle w:val="Strong"/>')).toEqual({ bold: false, italic: true, caps: true })
		expect(run(bold, '<w:rStyle w:val="Strong"/><w:b/>')).toEqual({ bold: true, italic: true, caps: true })
		expect(run(bold, '<w:b w:val="0"/><w:i w:val="0"/>')).toEqual({ bold: false, italic: false, caps: false })
		// Within one basedOn chain the derived style overrides its base.
		expect(run(derived, "")).toEqual({ bold: false, italic: true, caps: false })
		expect(run(derived, '<w:rStyle w:val="Strong"/>')).toEqual({ bold: true, italic: true, caps: true })
	})

	it("resolves theme fonts per slot and drops the other form when a slot is set again", () => {
		const f = fixture(
			NORMAL + '<w:style w:type="paragraph" w:styleId="Arial"><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr></w:style>',
			'<w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:lang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>'
		)
		const normal = f.resolver.paragraph(f.paragraph(""))
		const arial = f.resolver.paragraph(f.paragraph('<w:pStyle w:val="Arial"/>'))

		// Without w:themeFontLang, East Asian and complex-script references take a:ea and a:cs (empty here).
		expect(f.resolver.run(normal, f.run("")).fonts).toEqual({
			ascii: "Calibri",
			hAnsi: "Calibri",
			eastAsia: "Times New Roman",
			cs: "Times New Roman",
			hint: "default",
			eastAsiaUsesAscii: true
		})
		expect(f.resolver.run(arial, f.run("")).fonts.ascii).toBe("Arial")
		expect(f.resolver.run(arial, f.run('<w:rFonts w:asciiTheme="majorHAnsi"/>')).fonts.ascii).toBe("Calibri Light")
		// The run's own w:lang plays no part in theme font mapping.
		expect(f.resolver.run(normal, f.run('<w:lang w:eastAsia="zh-CN"/>')).fonts.eastAsia).toBe("Times New Roman")
	})

	it("uses w:themeFontLang when runs name no language", () => {
		const f = fixture(
			NORMAL,
			'<w:rPrDefault><w:rPr><w:rFonts w:eastAsiaTheme="majorEastAsia"/></w:rPr></w:rPrDefault>',
			undefined,
			'<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>'
		)

		expect(f.resolver.run(f.resolver.paragraph(f.paragraph("")), f.run("")).fonts.eastAsia).toBe("等线 Light")
		expect(f.resolver.run(f.resolver.paragraph(f.paragraph("")), f.run('<w:lang w:eastAsia="ja-JP"/>')).fonts.eastAsia).toBe(
			"等线 Light"
		)
	})

	it("resolves colours through the theme, highlight names, underline colour and automatic colour", () => {
		const f = fixture(NORMAL)
		const paragraph = f.resolver.paragraph(f.paragraph(""))
		const props = f.resolver.run(
			paragraph,
			f.run(
				'<w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/><w:highlight w:val="darkCyan"/><w:u w:val="wave" w:color="auto"/>' +
					'<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6" w:themeFill="background2"/><w:bdr w:val="single" w:sz="4" w:color="FF0000" w:themeColor="text1"/>'
			)
		)

		expect(props.color).toBe("2F5496")
		expect(props.highlight).toBe("008080")
		expect(props.underline).toEqual({ style: "wave", color: undefined })
		expect(props.shading).toEqual({ pattern: "clear", color: undefined, fill: "E7E6E6" })
		expect(props.border).toMatchObject({ style: "single", size: 4, color: "000000" })
		expect(f.resolver.run(paragraph, f.run('<w:color w:val="auto"/><w:u w:val="none"/><w:highlight w:val="none"/>'))).toMatchObject({
			color: undefined,
			underline: undefined,
			highlight: undefined
		})
		expect(f.resolver.run(paragraph, f.run('<w:color w:val="00FF00" w:themeColor="accent9"/>')).color).toBe("00FF00")
	})

	it("keeps Word's stored value when it agrees with the theme colour, and recomputes a stale one", () => {
		const f = fixture(NORMAL)
		const paragraph = f.resolver.paragraph(f.paragraph(""))
		const color = (inner: string): string | undefined => f.resolver.run(paragraph, f.run(inner)).color

		expect(color('<w:color w:val="2F5597" w:themeColor="accent1" w:themeShade="BF"/>')).toBe("2F5597")
		expect(color('<w:color w:val="123456" w:themeColor="accent1" w:themeShade="BF"/>')).toBe("2F5496")
		expect(color('<w:color w:themeColor="accent2"/>')).toBe("ED7D31")
		expect(new PropertyResolver().color({ val: "112233", themeColor: "accent1" })).toBe("112233")
	})

	it("defaults every field and interns equal results", () => {
		const f = fixture(NORMAL + '<w:style w:type="paragraph" w:styleId="Other"><w:pPr><w:jc w:val="center"/></w:pPr></w:style>')
		const a = f.resolver.paragraph(f.paragraph(""))
		const b = f.resolver.paragraph(f.paragraph('<w:pStyle w:val="Other"/>'))
		const run = f.resolver.run(a, f.run(""))

		expect(run).toMatchObject({ size: 20, sizeCs: 20, scale: 100, kern: 0, vertAlign: "baseline", snapToGrid: true, bold: false })
		expect(run.fonts.ascii).toBe("Times New Roman")
		expect(f.resolver.run(b, f.run(""))).toBe(run)
		expect(f.resolver.run(a, f.run("<w:b/>"))).not.toBe(run)
		expect(f.resolver.run(a, f.run("<w:b/>")).id).toBe(f.resolver.run(b, f.run("<w:b/>")).id)
		expect(a.props).not.toBe(b.props)
		expect(f.resolver.stats().runs).toBe(2)
	})

	it("treats a character style reference to a linked paragraph style as its linked character style", () => {
		const f = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:link w:val="Heading1Char"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style>' +
				'<w:style w:type="character" w:styleId="Heading1Char"><w:link w:val="Heading1"/><w:rPr><w:sz w:val="32"/><w:color w:val="1F3864"/></w:rPr></w:style>'
		)
		const normal = f.resolver.paragraph(f.paragraph(""))
		const linkedParagraph = f.resolver.paragraph(f.paragraph('<w:pStyle w:val="Heading1Char"/>'))

		expect(f.resolver.run(normal, f.run('<w:rStyle w:val="Heading1"/>'))).toMatchObject({ styleId: "Heading1Char", color: "1F3864" })
		expect(linkedParagraph.props.styleId).toBe("Heading1")
		expect(f.resolver.paragraph(f.paragraph('<w:pStyle w:val="Nope"/>')).props.styleId).toBe("Normal")
	})
})

describe("paragraph resolution", () => {
	it("merges spacing per attribute, indents with firstLine/hanging exclusivity and tabs with clears", () => {
		const f = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="List"><w:pPr><w:spacing w:before="120" w:beforeLines="50" w:line="360" w:lineRule="exact"/><w:ind w:left="720" w:hanging="360"/>' +
				'<w:tabs><w:tab w:val="left" w:pos="1440"/><w:tab w:val="right" w:leader="dot" w:pos="9000"/></w:tabs></w:pPr></w:style>',
			'<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
		)
		const props = f.resolver.paragraph(
			f.paragraph(
				'<w:pStyle w:val="List"/><w:spacing w:before="0"/><w:ind w:firstLine="200"/><w:tabs><w:tab w:val="clear" w:pos="1440"/><w:tab w:val="center" w:pos="4000"/></w:tabs>'
			)
		).props

		expect(props.spacing).toEqual({
			before: 0,
			beforeLines: undefined,
			beforeAutospacing: false,
			after: 160,
			afterLines: undefined,
			afterAutospacing: false,
			line: 360,
			lineRule: "exact"
		})
		expect(props.indent).toEqual({
			start: 720,
			end: 0,
			firstLine: 200,
			startChars: undefined,
			endChars: undefined,
			firstLineChars: undefined
		})
		expect(props.tabs).toEqual([
			{ alignment: "center", position: 4000, leader: "none" },
			{ alignment: "end", position: 9000, leader: "dot" }
		])
		expect(f.resolver.paragraph(f.paragraph('<w:pStyle w:val="List"/>')).props.indent.firstLine).toBe(-360)
	})

	it("lets hanging win over firstLine given on the same w:ind", () => {
		const f = fixture(NORMAL)
		const indent = f.resolver.paragraph(
			f.paragraph('<w:ind w:left="1440" w:firstLine="720" w:hanging="720" w:firstLineChars="100" w:hangingChars="200"/>')
		).props.indent

		expect(indent.firstLine).toBe(-720)
		expect(indent.firstLineChars).toBe(-200)
		// A direct firstLine still beats a hanging inherited from the style.
		const styled = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="List"><w:pPr><w:ind w:left="720" w:firstLine="100" w:hanging="360"/></w:pPr></w:style>'
		)

		expect(styled.resolver.paragraph(styled.paragraph('<w:pStyle w:val="List"/>')).props.indent.firstLine).toBe(-360)
		expect(
			styled.resolver.paragraph(styled.paragraph('<w:pStyle w:val="List"/><w:ind w:firstLine="200"/>')).props.indent.firstLine
		).toBe(200)
	})

	it("shares one borders object between paragraphs with equal w:pBdr and other differences", () => {
		const f = fixture(NORMAL)
		const pBdr =
			'<w:pBdr><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:between w:val="single" w:sz="4"/></w:pBdr>'
		const centred = f.resolver.paragraph(f.paragraph(pBdr + '<w:keepNext/><w:jc w:val="center"/>')).props
		const plain = f.resolver.paragraph(f.paragraph(pBdr)).props

		expect(centred).not.toBe(plain)
		expect(centred.borders).toBeDefined()
		expect(centred.borders).toBe(plain.borders)
		expect(f.resolver.paragraph(f.paragraph('<w:pBdr><w:top w:val="double" w:sz="4"/></w:pBdr>')).props.borders).not.toBe(plain.borders)
	})

	it("maps alignment to the physical side for the paragraph direction", () => {
		const f = fixture(NORMAL)
		const align = (inner: string): string => f.resolver.paragraph(f.paragraph(inner)).props.physicalAlignment

		expect(align("")).toBe("left")
		expect(align("<w:bidi/>")).toBe("right")
		expect(align('<w:jc w:val="left"/><w:bidi/>')).toBe("right")
		expect(align('<w:jc w:val="right"/><w:bidi/>')).toBe("left")
		expect(align('<w:jc w:val="end"/>')).toBe("right")
		expect(align('<w:jc w:val="center"/><w:bidi/>')).toBe("center")
		expect(align('<w:jc w:val="both"/>')).toBe("justify")
		expect(align('<w:jc w:val="lowKashida"/>')).toBe("justify")
		expect(align('<w:jc w:val="distribute"/>')).toBe("distribute")
	})

	it("fills Word's defaults and resolves borders, shading and outline level", () => {
		const f = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="H"><w:pPr><w:outlineLvl w:val="2"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="auto"/></w:pBdr></w:pPr></w:style>'
		)
		const plain = f.resolver.paragraph(f.paragraph("")).props
		const heading = f.resolver.paragraph(
			f.paragraph(
				'<w:pStyle w:val="H"/><w:pBdr><w:top w:val="nil"/></w:pBdr><w:shd w:val="clear" w:fill="FFF2CC" w:themeFill="accent4" w:themeFillTint="33"/>'
			)
		).props

		expect(plain).toMatchObject({
			widowControl: true,
			keepNext: false,
			outlineLevel: undefined,
			borders: undefined,
			textAlignment: "auto",
			kinsoku: true
		})
		expect(heading.outlineLevel).toBe(2)
		expect(heading.borders?.bottom).toMatchObject({ style: "single", size: 6, color: undefined })
		expect(heading.borders?.top).toBeUndefined()
		expect(heading.shading?.fill).toBe("FFF2CC")
		expect(f.resolver.paragraph(f.paragraph('<w:outlineLvl w:val="9"/>')).props.outlineLevel).toBeUndefined()
	})
})

describe("numbering in the cascade", () => {
	const NUMBERING =
		'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/><w:spacing w:after="40"/></w:pPr>' +
		'<w:rPr><w:color w:val="C00000"/><w:b w:val="0"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
	const STYLES =
		NORMAL +
		'<w:style w:type="paragraph" w:styleId="Indented"><w:pPr><w:ind w:left="1440"/><w:spacing w:after="0"/></w:pPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="ListBase"><w:pPr><w:ind w:left="2880"/></w:pPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="ListNumber"><w:basedOn w:val="ListBase"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="ListNumberOwn"><w:basedOn w:val="ListBase"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:ind w:left="100"/></w:pPr></w:style>'

	it("applies a direct list level before the paragraph style (§17.7.2), indents included", () => {
		const f = fixture(STYLES, "", NUMBERING)
		const props = f.resolver.paragraph(
			f.paragraph('<w:pStyle w:val="Indented"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
		).props

		expect(props.numbering).toEqual({ numId: 1, ilvl: 0 })
		expect(props.indent).toMatchObject({ start: 1440, firstLine: -360 })
		expect(props.spacing.after).toBe(0)
	})

	it("lets the paragraph style's indents, inherited ones included, beat the level it numbers through", () => {
		const f = fixture(STYLES, "", NUMBERING)

		expect(f.resolver.paragraph(f.paragraph('<w:pStyle w:val="ListNumber"/>')).props.indent).toMatchObject({
			start: 2880,
			firstLine: -360
		})
		expect(f.resolver.paragraph(f.paragraph('<w:pStyle w:val="ListNumberOwn"/>')).props.indent).toMatchObject({
			start: 100,
			firstLine: -360
		})
	})

	it("removes style numbering with numId 0 and ignores unknown nums", () => {
		const f = fixture(STYLES, "", NUMBERING)

		expect(
			f.resolver.paragraph(f.paragraph('<w:pStyle w:val="ListNumber"/><w:numPr><w:numId w:val="0"/></w:numPr>')).props.numbering
		).toBeUndefined()
		expect(f.resolver.paragraph(f.paragraph('<w:numPr><w:numId w:val="42"/></w:numPr>')).props.numbering).toBeUndefined()
	})

	it("formats the list marker from the paragraph mark (minus underline and hiding) and the level", () => {
		const f = fixture(STYLES, "", NUMBERING)
		const paragraph = f.resolver.paragraph(
			f.paragraph('<w:numPr><w:numId w:val="1"/></w:numPr><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:vanish/></w:rPr>')
		)
		const marker = f.resolver.listMarker(paragraph)

		expect(marker).toMatchObject({ bold: false, italic: true, underline: undefined, vanish: false, color: "C00000" })
		expect(f.resolver.paragraphMark(paragraph)).toMatchObject({ bold: true, italic: true, vanish: true })
		expect(f.resolver.listMarker(paragraph)).toBe(marker)
		expect(f.resolver.listMarker(f.resolver.paragraph(f.paragraph("")))).toBeUndefined()
	})
})

describe("table styles", () => {
	const TABLE_STYLES =
		NORMAL +
		'<w:style w:type="paragraph" w:styleId="Body"><w:rPr><w:sz w:val="26"/></w:rPr></w:style>' +
		'<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
		'<w:style w:type="table" w:styleId="Grid"><w:basedOn w:val="TableNormal"/><w:rPr><w:sz w:val="18"/></w:rPr><w:tblPr><w:tblStyleRowBandSize w:val="1"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>' +
		'<w:tcPr><w:shd w:val="clear" w:fill="FFFFFF"/></w:tcPr>' +
		'<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:trPr><w:tblHeader/></w:trPr><w:tcPr><w:shd w:val="clear" w:fill="4472C4" w:themeFill="accent1"/></w:tcPr></w:tblStylePr>' +
		'<w:tblStylePr w:type="lastRow"><w:rPr><w:i/></w:rPr></w:tblStylePr>' +
		'<w:tblStylePr w:type="firstCol"><w:rPr><w:b/></w:rPr><w:tcPr><w:tcMar><w:left w:w="200" w:type="dxa"/></w:tcMar></w:tcPr></w:tblStylePr>' +
		'<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr>' +
		'<w:tblStylePr w:type="band1Vert"><w:tcPr><w:shd w:val="clear" w:fill="EEEEEE"/></w:tcPr></w:tblStylePr>' +
		'<w:tblStylePr w:type="nwCell"><w:tcPr><w:shd w:val="clear" w:fill="000000"/></w:tcPr></w:tblStylePr>' +
		'<w:tblStylePr w:type="wholeTable"><w:pPr><w:spacing w:after="0"/></w:pPr></w:tblStylePr></w:style>'

	function cellAt(f: Fixture, table: ReturnType<PropertyResolver["table"]>, rowIndex: number, gridColumn: number, tcPr: string = "") {
		return f.resolver.cell(table, f.cell(tcPr), { rowIndex, rowCount: 4, gridColumn, gridSpan: 1, gridColumnCount: 3 })
	}

	it("selects conditions by position, gated by tblLook, in Word's order", () => {
		const look = DEFAULT_TABLE_LOOK
		const names = (mask: number): string[] => CONDITION_ORDER.filter(type => (mask & conditionBit(type)) !== 0)

		expect(names(cellConditions(look, { rowIndex: 0, rowCount: 3, gridColumn: 0, gridSpan: 1, gridColumnCount: 3 }, 1, 1))).toEqual([
			"wholeTable",
			"band1Horz",
			"firstCol",
			"firstRow",
			"nwCell"
		])
		expect(names(cellConditions(look, { rowIndex: 1, rowCount: 3, gridColumn: 1, gridSpan: 1, gridColumnCount: 3 }, 1, 1))).toEqual([
			"wholeTable",
			"band1Horz"
		])
		expect(names(cellConditions(look, { rowIndex: 2, rowCount: 3, gridColumn: 1, gridSpan: 1, gridColumnCount: 3 }, 1, 1))).toEqual([
			"wholeTable",
			"band2Horz"
		])

		const all = { firstRow: true, lastRow: true, firstColumn: true, lastColumn: true, noHBand: true, noVBand: false }

		expect(names(cellConditions(all, { rowIndex: 2, rowCount: 3, gridColumn: 1, gridSpan: 2, gridColumnCount: 3 }, 1, 2))).toEqual([
			"wholeTable",
			"band1Vert",
			"lastCol",
			"lastRow",
			"seCell"
		])
		// Position alone decides: w:cnfStyle is a cache, so a first-row flag on a body cell adds nothing.
		expect(
			names(
				cellConditions(
					{ ...all, firstRow: false, lastRow: false },
					{ rowIndex: 1, rowCount: 3, gridColumn: 1, gridSpan: 1, gridColumnCount: 3 },
					1,
					1
				)
			)
		).toEqual(["wholeTable", "band1Vert"])
	})

	it("applies conditional cell formatting, the style's base cell properties and direct w:tcPr", () => {
		const f = fixture(TABLE_STYLES)
		const table = f.resolver.table(f.table('<w:tblStyle w:val="Grid"/><w:tblLook w:val="04A0"/>'))

		expect(table.props).toMatchObject({ styleId: "Grid", rowBandSize: 1, layout: "autofit", physicalAlignment: "left" })
		expect(table.props.borders.top).toMatchObject({ style: "single", size: 4 })
		expect(table.props.cellMargins.start).toEqual({ value: 108, type: "dxa" })
		expect(cellAt(f, table, 0, 0).props.shading?.fill).toBe("000000")
		expect(cellAt(f, table, 0, 1).props.shading?.fill).toBe("4472C4")
		expect(cellAt(f, table, 1, 1).props.shading?.fill).toBe("D9E2F3")
		expect(cellAt(f, table, 2, 1).props.shading?.fill).toBe("FFFFFF")
		expect(cellAt(f, table, 2, 1, '<w:shd w:val="clear" w:fill="FF0000"/>').props.shading?.fill).toBe("FF0000")
		expect(cellAt(f, table, 2, 0).props.margins.start).toEqual({ value: 200, type: "dxa" })
		expect(cellAt(f, table, 2, 0, '<w:tcMar><w:start w:w="10" w:type="dxa"/></w:tcMar>').props.margins.start).toEqual({
			value: 10,
			type: "dxa"
		})
		expect(f.resolver.row(table, f.store.row(f.document, -1), { rowIndex: 0, rowCount: 4 }).header).toBe(true)
		expect(f.resolver.row(table, f.store.row(f.document, -1), { rowIndex: 1, rowCount: 4 }).header).toBe(false)
	})

	it("feeds table style run and paragraph properties into the cell's paragraphs", () => {
		const f = fixture(TABLE_STYLES, '<w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>')
		const table = f.resolver.table(f.table('<w:tblStyle w:val="Grid"/>'))
		const header = cellAt(f, table, 0, 1)
		const body = cellAt(f, table, 1, 1)
		const firstColumn = cellAt(f, table, 1, 0)
		const run = (cell: ReturnType<typeof cellAt>, pPr: string = "", rPr: string = "") =>
			f.resolver.run(f.resolver.paragraph(f.paragraph(pPr), cell), f.run(rPr))

		expect(run(header)).toMatchObject({ bold: true, color: "FFFFFF", size: 18 })
		expect(run(body)).toMatchObject({ bold: false, size: 18 })
		// firstRow and firstCol both turn bold on: one table style level, so they do not cancel.
		expect(run(cellAt(f, table, 0, 0))).toMatchObject({ bold: true })
		expect(run(firstColumn)).toMatchObject({ bold: true })
		// A table style overrides the default paragraph style, not other paragraph styles.
		expect(run(body, '<w:pStyle w:val="Body"/>')).toMatchObject({ size: 26 })
		expect(f.resolver.paragraph(f.paragraph(""), body).props.spacing.after).toBe(0)
		// Cells with the same conditions share paragraph formats.
		expect(f.resolver.paragraph(f.paragraph(""), cellAt(f, table, 3, 1))).toBe(f.resolver.paragraph(f.paragraph(""), body))
		expect(f.resolver.paragraph(f.paragraph(""), cellAt(f, table, 2, 1))).not.toBe(f.resolver.paragraph(f.paragraph(""), body))
	})

	it("uses the default table style, the default look and tblPrEx", () => {
		const f = fixture(TABLE_STYLES)
		const plain = f.resolver.table(f.table('<w:tblW w:w="5000" w:type="pct"/><w:jc w:val="right"/><w:bidiVisual/>'))
		const excepted = f.resolver.table(
			f.table('<w:tblStyle w:val="Grid"/>'),
			f.table('<w:tblBorders><w:top w:val="nil"/></w:tblBorders><w:tblCellMar><w:left w:w="0" w:type="dxa"/></w:tblCellMar>')
		)

		expect(plain.props).toMatchObject({
			styleId: "TableNormal",
			width: { value: 5000, type: "pct" },
			physicalAlignment: "left",
			look: DEFAULT_TABLE_LOOK
		})
		expect(plain.props.cellMargins.end).toEqual({ value: 108, type: "dxa" })
		expect(excepted.props.borders.top).toBeUndefined()
		expect(excepted.props.cellMargins.start).toEqual({ value: 0, type: "dxa" })
		expect(f.resolver.table(f.table('<w:tblStyle w:val="Grid"/>'))).toBe(f.resolver.table(f.table('<w:tblStyle w:val="Grid"/>')))
	})
})

describe("review cases", () => {
	it("measures toggles in styles against the document defaults (MS-OI29500)", () => {
		const f = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="On"><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Off"><w:rPr><w:b w:val="0"/></w:rPr></w:style>' +
				'<w:style w:type="character" w:styleId="CharOff"><w:rPr><w:b w:val="0"/></w:rPr></w:style>',
			"<w:rPrDefault><w:rPr><w:b/></w:rPr></w:rPrDefault>"
		)
		const bold = (style: string, rPr: string = ""): boolean =>
			f.resolver.run(f.resolver.paragraph(f.paragraph(`<w:pStyle w:val="${style}"/>`)), f.run(rPr)).bold

		expect(bold("Normal")).toBe(true)
		expect(bold("On")).toBe(true)
		expect(bold("Off")).toBe(false)
		expect(bold("Off", '<w:rStyle w:val="CharOff"/>')).toBe(true)
		expect(bold("Off", "<w:b/>")).toBe(true)
	})

	it("orders the default paragraph style after the table style, with MS-DOCX's size and justification exceptions", () => {
		const styles = (normal: string): string =>
			`<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>${normal}</w:style>` +
			'<w:style w:type="paragraph" w:styleId="Body"><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>' +
			'<w:style w:type="table" w:styleId="T"><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="18"/><w:color w:val="0000FF"/></w:rPr></w:style>'
		const inCell = (f: Fixture, pPr: string = "") => {
			const table = f.resolver.table(f.table('<w:tblStyle w:val="T"/>'))
			const cell = f.resolver.cell(table, f.cell(""), { rowIndex: 1, rowCount: 3, gridColumn: 1, gridSpan: 1, gridColumnCount: 3 })
			const paragraph = f.resolver.paragraph(f.paragraph(pPr), cell)

			return { props: paragraph.props, run: f.resolver.run(paragraph, f.run("")) }
		}
		const typical = fixture(
			styles(
				'<w:pPr><w:spacing w:after="200"/><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="22"/><w:color w:val="FF0000"/></w:rPr>'
			)
		)
		const plain = inCell(typical)

		// §17.7.2: the paragraph style comes after the table style...
		expect(plain.props.spacing.after).toBe(200)
		expect(plain.run.color).toBe("FF0000")
		// ...except for the default style's 11pt size and left justification.
		expect(plain.run.size).toBe(18)
		expect(plain.props.alignment).toBe("center")
		// A derived style setting the size itself is not the default style's value.
		expect(inCell(typical, '<w:pStyle w:val="Body"/>').run.size).toBe(22)

		const large = inCell(fixture(styles('<w:pPr><w:jc w:val="right"/></w:pPr><w:rPr><w:sz w:val="28"/></w:rPr>')))

		expect(large.run.size).toBe(28)
		expect(large.props.alignment).toBe("right")

		const overriding = fixture(
			styles('<w:pPr><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr>'),
			"",
			undefined,
			'<w:compat><w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat>'
		)

		expect(inCell(overriding).run.size).toBe(24)
		expect(inCell(overriding).props.alignment).toBe("left")
	})

	it("treats a link written on one side of a paragraph/character pair as linking both ways", () => {
		const f = fixture(
			NORMAL +
				'<w:style w:type="paragraph" w:styleId="P"><w:link w:val="PC"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>' +
				'<w:style w:type="character" w:styleId="PC"><w:rPr><w:color w:val="00FF00"/></w:rPr></w:style>'
		)

		expect(f.resolver.paragraph(f.paragraph('<w:pStyle w:val="PC"/>')).props.styleId).toBe("P")
		expect(f.resolver.run(f.resolver.paragraph(f.paragraph("")), f.run('<w:rStyle w:val="P"/>')).styleId).toBe("PC")
	})

	it("does not draw East Asian text with the ascii font when an East Asian font is named", () => {
		const f = fixture(
			NORMAL,
			'<w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="MS Mincho"/></w:rPr></w:rPrDefault>'
		)

		expect(f.resolver.run(f.resolver.paragraph(f.paragraph("")), f.run("")).fonts).toMatchObject({
			eastAsia: "MS Mincho",
			cs: "Times New Roman",
			eastAsiaUsesAscii: false
		})
	})

	it("reads the settings the resolver needs through the model's settings reader", () => {
		const settings = readStyleSettings(
			xml(
				`<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="0.5in"/><w:clrSchemeMapping w:bg1="dark1" w:t1="light1"/><w:themeFontLang w:val="de-DE" w:eastAsia="ja-JP"/>` +
					'<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>'
			)
		)

		expect(settings).toMatchObject({ defaultTabStop: 720, compatibilityMode: 15, overrideTableStyleFontSizeAndJustification: false })
		expect(settings.themeFontLanguage).toEqual({ latin: "de-DE", eastAsia: "ja-JP" })
		expect(settings.colorMapping).toMatchObject({ bg1: "dark1", t1: "light1", t2: "dark2" })
	})
})

describe("sections", () => {
	it("fills Word's defaults and swaps landscape dimensions", () => {
		const store = new PropsStore()
		const document = wordPart(
			"document",
			'<w:sectPr><w:pgSz w:w="11906" w:h="16838" w:orient="landscape"/><w:cols w:num="3"/></w:sectPr><w:sectPr/>'
		)
		const resolver = new PropertyResolver()
		const landscape = resolver.section(store.section(document, find(document, "w:sectPr")))
		const empty = resolveSection(store.section(document, -1))

		expect(landscape).toMatchObject({
			pageWidth: 16838,
			pageHeight: 11906,
			orient: "landscape",
			columns: { count: 3, space: 720, equalWidth: true }
		})
		expect(empty).toMatchObject({
			type: "nextPage",
			pageWidth: 12240,
			pageHeight: 15840,
			orient: "portrait",
			titlePage: false,
			vAlign: "top"
		})
		expect(empty.margins).toEqual({ top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 })
	})
})
