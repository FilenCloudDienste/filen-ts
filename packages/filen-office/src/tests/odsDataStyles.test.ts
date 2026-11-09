import { describe, expect, it } from "vitest"
import { NUMFMT_EN_US } from "../core/sheet/numfmt/index"
import { formatStandard, formatValue, formatValue as formatWith } from "../core/sheet/numfmt/format"
import { OdfStyleSheet } from "../core/odf/styles"
import { parseXml } from "../core/xml/index"
import { dataStyleCode } from "../core/ods/styles/dataStyle"
import { dataStyles, sameShown } from "../core/ods/write/dataStyle"
import { numFmtLocaleFor } from "../core/ods/styles/locale"
import { DEFAULT_PALETTE } from "../core/sheet/style/palette"
import { ODS_NS } from "./odsFixtures"

// ODF data styles (ODF 1.3 Part 3 §16.29) as number format codes, and the formatter's options for what LibreOffice
// shows that Excel does not: a style's language separators, and General as "Standard".

function code(styles: string, name: string): { code: string; held: readonly string[] } {
	const document = parseXml(
		new TextEncoder().encode(`<office:document-styles ${ODS_NS}><office:styles>${styles}</office:styles></office:document-styles>`)
	)
	const sheet = new OdfStyleSheet(document, undefined)
	const style = sheet.dataStyle(name, "styles")

	if (style === undefined) throw new Error(`no ${name}`)

	return dataStyleCode(sheet, style, "styles")
}

describe("ODF data styles as number formats", () => {
	it("reads digits, grouping, decimals, display factor and embedded text", () => {
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>',
				"N"
			).code
		).toBe("#,##0.00")
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="3" number:min-decimal-places="1" number:min-integer-digits="1"/></number:number-style>',
				"N"
			).code
		).toBe("0.0##")
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="1" number:display-factor="1000"/></number:number-style>',
				"N"
			).code
		).toBe("0,")
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="5"><number:embedded-text number:position="3">-</number:embedded-text></number:number></number:number-style>',
				"N"
			).code
		).toBe("00-000")
	})

	it("pads an embedded text placed left of every digit with optional digits, as LibreOffice does", () => {
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="1"><number:embedded-text number:position="3">-</number:embedded-text></number:number></number:number-style>',
				"N"
			).code
		).toBe("#-##0")
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="0"><number:embedded-text number:position="4">-</number:embedded-text></number:number></number:number-style>',
				"N"
			).code
		).toBe("#-####")
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="4"><number:embedded-text number:position="4">-</number:embedded-text></number:number></number:number-style>',
				"N"
			).code
		).toBe("#-0000")
	})

	it("joins embedded texts at one position and counts no digit inside a quoted one", () => {
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="5"><number:embedded-text number:position="3">a</number:embedded-text><number:embedded-text number:position="3">0</number:embedded-text><number:embedded-text number:position="1">-</number:embedded-text></number:number></number:number-style>',
				"N"
			).code
		).toBe('00"a0"00-0')
	})

	it("writes Excel's Special formats (Zip Code + 4, Phone Number, Social Security Number) as embedded text", () => {
		const ssn = dataStyles("000-00-0000", "N")

		if ("refused" in ssn) throw new Error(ssn.refused)

		expect(ssn.styles[0]?.markup).toBe(
			'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="9"><number:embedded-text number:position="6">-</number:embedded-text><number:embedded-text number:position="4">-</number:embedded-text></number:number></number:number-style>'
		)

		const shown: Record<string, readonly [number, string][]> = {
			"00000-0000": [[123456789, "12345-6789"]],
			"000-00-0000": [[123456789, "123-45-6789"]],
			"###-####": [
				[5551234, "555-1234"],
				[12, "-12"]
			],
			"[<=9999999]###-####;(###) ###-####": [
				[5551234, "555-1234"],
				[2065551234, "(206) 555-1234"]
			],
			'#,##0" x "0': []
		}

		for (const [format, cases] of Object.entries(shown)) {
			const written = dataStyles(format, "N")

			if ("refused" in written) throw new Error(`${format}: ${written.refused}`)

			const back = code(written.styles.map(style => style.markup).join(""), "N").code

			expect(back === format || sameShown(format, back), `${format} read back as ${back}`).toBe(true)

			for (const [value, text] of cases) expect(formatValue(value, back).text, `${format} ${String(value)}`).toBe(text)
		}

		// A literal in the fraction part, or before the point, has no element.
		for (const format of ["0.0-0", "0-.0", "0%0"]) expect(dataStyles(format, "N")).toEqual({ refused: "embedded text" })
	})

	it("writes a [ColorN] colour as the workbook palette's entry", () => {
		const markup = (written: ReturnType<typeof dataStyles>): string =>
			"refused" in written ? written.refused : written.styles.map(style => style.markup).join("")

		// [Color10] is palette index 17: dark green by default.
		expect(markup(dataStyles("[Magenta]0;[Color10]-0", "N"))).toContain('<style:text-properties fo:color="#008000"/>')

		const palette = DEFAULT_PALETTE.slice()

		palette[17] = 0x123456

		const custom = markup(dataStyles("[Color10]0", "N", palette))

		expect(custom).toContain('<style:text-properties fo:color="#123456"/>')
		expect(dataStyles("[Color10]0", "N", [])).toEqual({ refused: "colour index" })

		// The colour shown, not the code, decides: [Color3] reads back as [Red].
		const red = dataStyles("[Color3]0", "N")

		if ("refused" in red) throw new Error(red.refused)

		const back = code(red.styles.map(style => style.markup).join(""), "N").code

		expect(back).toBe("[Red]0")
		expect(sameShown("[Color3]0", back)).toBe(true)
		expect(sameShown("[Color10]0", "[Color10]0", { palette }, {})).toBe(false)
	})

	it("bounds hostile digit counts and embedded text positions, holding the style", () => {
		const huge = "300000000"
		const styles = [
			`<number:number number:decimal-places="2" number:min-integer-digits="1"><number:embedded-text number:position="${huge}">x</number:embedded-text></number:number>`,
			`<number:number number:decimal-places="${huge}" number:min-integer-digits="1"/>`,
			`<number:number number:decimal-places="2" number:min-integer-digits="${huge}"/>`,
			`<number:scientific-number number:decimal-places="${huge}" number:min-integer-digits="${huge}" number:min-exponent-digits="${huge}"/>`,
			`<number:fraction number:min-integer-digits="${huge}" number:min-numerator-digits="${huge}" number:min-denominator-digits="${huge}"/>`,
			`<number:fraction number:min-numerator-digits="1" number:denominator-value="${"9".repeat(1000)}"/>`
		]

		for (const body of styles) {
			const result = code(`<number:number-style style:name="N">${body}</number:number-style>`, "N")

			expect(result.code.length).toBeLessThan(1000)
			expect(result.held.length).toBeGreaterThan(0)
		}
	})

	it("reads LibreOffice's Standard (min-integer-digits alone) as General", () => {
		expect(
			code('<number:number-style style:name="N0"><number:number number:min-integer-digits="1"/></number:number-style>', "N0").code
		).toBe("General")
	})

	it("reads an empty map target, and an empty main with maps, as an empty section, not General", () => {
		const positive =
			'<number:number-style style:name="P"><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>'
		const negative =
			'<number:number-style style:name="M"><number:text>-</number:text><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>'
		const zero = '<number:number-style style:name="Z"/>'
		const read = code(
			`${positive}${negative}${zero}<number:text-style style:name="T"><number:text-content/><style:map style:condition="value()&gt;0" style:apply-style-name="P"/><style:map style:condition="value()&lt;0" style:apply-style-name="M"/><style:map style:condition="value()=0" style:apply-style-name="Z"/></number:text-style>`,
			"T"
		).code

		expect(read).toBe("0;-0;;@")
		expect([5, 0, -3].map(value => formatValue(value, read).text)).toEqual(["5", "", "-3"])
		expect(
			code(
				`${positive}<number:number-style style:name="N"><style:map style:condition="value()&gt;0" style:apply-style-name="P"/></number:number-style>`,
				"N"
			).code
		).toBe("0;;")
	})

	it("round-trips codes with empty sections through the writer", () => {
		for (const format of ["0;-0;;@", "#,##0;-#,##0;", "0;;", ";;;@"]) {
			const written = dataStyles(format, "N")

			if ("refused" in written) throw new Error(written.refused)

			const back = code(written.styles.map(style => style.markup).join(""), "N").code

			expect(sameShown(format, back), `${format} read back as ${back}`).toBe(true)
		}
	})

	it("keeps a percent sign a percent only in a percentage style", () => {
		expect(
			code(
				'<number:percentage-style style:name="P"><number:number number:decimal-places="1" number:min-decimal-places="1" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>',
				"P"
			).code
		).toBe("0.0%")
		expect(
			code(
				'<number:number-style style:name="N"><number:number number:decimal-places="0" number:min-integer-digits="1"/><number:text> %</number:text></number:number-style>',
				"N"
			).code
		).toBe('0" %"')
	})

	it("reads dates, times, elapsed hours and AM/PM", () => {
		expect(
			code(
				'<number:date-style style:name="D"><number:day number:style="long"/><number:text>.</number:text><number:month number:style="long"/><number:text>.</number:text><number:year number:style="long"/></number:date-style>',
				"D"
			).code
		).toBe('dd"."mm"."yyyy')
		expect(
			code(
				'<number:time-style style:name="T" number:truncate-on-overflow="false"><number:hours/><number:text>:</number:text><number:minutes number:style="long"/></number:time-style>',
				"T"
			).code
		).toBe("[h]:mm")
		expect(
			code(
				'<number:date-style style:name="D"><number:month number:textual="true"/><number:text> </number:text><number:year/><number:text> </number:text><number:hours/><number:text>:</number:text><number:minutes number:style="long"/><number:am-pm/></number:date-style>',
				"D"
			).code
		).toBe("mmm yy h:mmAM/PM")
	})

	it("takes a language's own date format where the style says so, en-US's without a language", () => {
		const parts = "<number:day/><number:text>.</number:text><number:month/><number:text>.</number:text><number:year/>"

		expect(
			code(
				`<number:date-style style:name="D" number:format-source="language" number:language="de" number:country="DE">${parts}</number:date-style>`,
				"D"
			).code
		).toBe("[$-407]dd.mm.yy")
		expect(code(`<number:date-style style:name="D" number:format-source="language">${parts}</number:date-style>`, "D").code).toBe(
			"m/d/yy"
		)
	})

	it("joins conditional maps into sections: >=0, >0 <0, and a text style's four", () => {
		const base =
			'<number:number-style style:name="P"><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/></number:number-style>' +
			'<number:number-style style:name="M"><number:text>(</number:text><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text>)</number:text></number:number-style>' +
			'<number:number-style style:name="Z"><number:text>-</number:text></number:number-style>'

		expect(
			code(
				`${base}<number:number-style style:name="N"><style:text-properties fo:color="#FF0000"/><number:text>-</number:text><number:number number:decimal-places="0" number:min-integer-digits="1"/><style:map style:condition="value()&gt;=0" style:apply-style-name="P"/></number:number-style>`,
				"N"
			).code
		).toBe("#,##0;[Red]-0;#,##0")
		expect(
			code(
				`${base}<number:text-style style:name="T"><number:text-content/><style:map style:condition="value()&gt;0" style:apply-style-name="P"/><style:map style:condition="value()&lt;0" style:apply-style-name="M"/><style:map style:condition="value()=0" style:apply-style-name="Z"/></number:text-style>`,
				"T"
			).code
		).toBe("#,##0;(#,##0);-;@")
	})

	it("shows a number no condition takes through the main style: a text style's literals without its text", () => {
		const date =
			'<number:date-style style:name="D"><number:month number:style="long"/><number:text>/</number:text><number:day number:style="long"/><number:text>/</number:text><number:year/></number:date-style>'

		expect(
			code(
				`${date}<number:text-style style:name="T"><number:text-content/><style:map style:condition="value()&gt;0" style:apply-style-name="D"/></number:text-style>`,
				"T"
			).code
		).toBe("mm/dd/yy;;;@")
		expect(
			code(
				'<number:text-style style:name="T"><number:text>n/a </number:text><number:text-content/><style:map style:condition="value()&gt;=0" style:apply-style-name="Gone"/></number:text-style>',
				"T"
			).code
		).toBe('"n/a ";"n/a ";"n/a ";"n/a "@')
	})

	it("tags a style's language, and the formatter shows its separators only when asked", () => {
		const converted = code(
			'<number:number-style style:name="N" number:language="de" number:country="DE"><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>',
			"N"
		).code

		expect(converted).toBe("[$-407]#,##0.00")
		expect(formatWith(1234.5, converted, { localeFor: numFmtLocaleFor, lcidSeparators: true }).text).toBe("1.234,50")
		expect(formatWith(1234.5, converted, { localeFor: numFmtLocaleFor }).text).toBe("1,234.50")
	})

	it("names what a code cannot say and shows the rest", () => {
		const quarter = code(
			'<number:date-style style:name="Q"><number:quarter/><number:text> </number:text><number:year number:style="long"/></number:date-style>',
			"Q"
		)

		expect(quarter).toEqual({ code: " yyyy", held: ["quarter"] })
		expect(
			code(
				'<number:number-style style:name="C"><style:text-properties fo:color="#123456"/><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>',
				"C"
			).held
		).toEqual(["color"])
	})
})

describe("LibreOffice's Standard format", () => {
	it("shows up to fifteen significant digits without a precision", () => {
		expect(formatStandard(3901626.79293667, -1)).toBe("3901626.79293667")
		expect(formatStandard(0.1 + 0.2, -1)).toBe("0.3")
		expect(formatStandard(1e20, -1)).toBe("1E+20")
		expect(formatStandard(-0.000123, -1)).toBe("-0.000123")
	})

	it("rounds to a precision and drops trailing zeros", () => {
		expect(formatStandard(0.967, 2)).toBe("0.97")
		expect(formatStandard(0.7, 2)).toBe("0.7")
		expect(formatStandard(16, 2)).toBe("16")
		expect(formatStandard(-0.001, 2)).toBe("0")
	})

	it("replaces General's eleven characters when the option is given", () => {
		expect(formatValue(3901626.79293667, "General", {}).text).toBe("3901626.793")
		expect(formatValue(3901626.79293667, "General", { standardPrecision: -1 }).text).toBe("3901626.79293667")
		expect(formatValue(-2.5, "General", { standardPrecision: 2, locale: { ...NUMFMT_EN_US, decimal: "," } }).text).toBe("-2,5")
	})
})
