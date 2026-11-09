import { describe, expect, it } from "vitest"
import { readStyleSettings } from "../core/docx/styles/index"
import {
	applyColorTransforms,
	applyThemeShade,
	applyThemeTint,
	parseTheme,
	readDrawingColor,
	scriptForLanguage,
	shadingColor
} from "../core/docx/theme/index"
import type { ColorMod } from "../core/presentation/model"
import { applyMods } from "../core/presentation/theme"
import { A, OFFICE_THEME, W, xml } from "./docxFixtures"

describe("theme part", () => {
	it("reads the colour scheme (sysClr through lastClr) and the font scheme", () => {
		const theme = parseTheme(OFFICE_THEME)

		expect(theme.name).toBe("Test")
		expect(theme.colors.get("dk1")).toBe("000000")
		expect(theme.colors.get("lt1")).toBe("FFFFFF")
		expect(theme.colors.get("accent1")).toBe("4472C4")
		expect(theme.colors.get("folHlink")).toBe("954F72")
		expect(theme.major.latin).toBe("Calibri Light")
		expect(theme.minor.scripts.get("Jpan")).toBe("游明朝")
	})

	it("maps w:themeColor names through w:clrSchemeMapping", () => {
		const theme = parseTheme(OFFICE_THEME)

		expect(theme.themeColor("text1")).toBe("000000")
		expect(theme.themeColor("background1")).toBe("FFFFFF")
		expect(theme.themeColor("text2")).toBe("44546A")
		expect(theme.themeColor("dark2")).toBe("44546A")
		expect(theme.themeColor("hyperlink")).toBe("0563C1")
		expect(theme.themeColor("followedHyperlink")).toBe("954F72")

		const inverted = readStyleSettings(
			xml(
				`<w:settings xmlns:w="${W}"><w:clrSchemeMapping w:bg1="dark1" w:t1="light1" w:bg2="dark2" w:t2="light2" w:accent1="accent6"/></w:settings>`
			)
		).colorMapping

		expect(theme.themeColor("text1", inverted)).toBe("FFFFFF")
		expect(theme.themeColor("background2", inverted)).toBe("44546A")
		expect(theme.themeColor("accent1", inverted)).toBe("70AD47")
		expect(theme.themeColor("dark1", inverted)).toBe("000000")
		expect(theme.schemeColor("tx1", inverted)).toBe("FFFFFF")
		expect(theme.schemeColor("accent2")).toBe("ED7D31")
		expect(theme.schemeColor("phClr")).toBeUndefined()
	})

	it("picks theme fonts by w:themeFontLang per slot, falling back to a:latin, a:ea and a:cs", () => {
		const theme = parseTheme(OFFICE_THEME)

		expect(theme.font("majorHAnsi")).toBe("Calibri Light")
		expect(theme.font("minorAscii", { latin: "en-US" })).toBe("Calibri")
		// §17.15.1.88's example: a Japanese val maps the Latin slots to the Jpan font too.
		expect(theme.font("minorAscii", { latin: "ja-JP" })).toBe("游明朝")
		expect(theme.font("minorEastAsia", { eastAsia: "ja-JP" })).toBe("游明朝")
		expect(theme.font("majorEastAsia", { eastAsia: "zh-CN" })).toBe("等线 Light")
		// Each slot reads only its own language attribute.
		expect(theme.font("minorEastAsia", { latin: "ja-JP" })).toBeUndefined()
		expect(theme.font("minorEastAsia", { eastAsia: "ko-KR" })).toBeUndefined()
		expect(theme.font("minorBidi", { bidi: "he-IL" })).toBe("Arial")
		expect(theme.font("majorBidi", { bidi: "ar-SA" })).toBe("Times New Roman")
		expect(scriptForLanguage("zh-TW")).toBe("Hant")
		expect(scriptForLanguage("zh-Hans-CN")).toBe("Hans")
		expect(scriptForLanguage("fa-IR")).toBe("Arab")
		expect(scriptForLanguage(undefined)).toBeUndefined()
	})

	it("reads Strict DrawingML and tolerates a missing or foreign root", () => {
		const strict = xml(
			'<a:theme xmlns:a="http://purl.oclc.org/ooxml/drawingml/main"><a:themeElements><a:clrScheme name="x"><a:accent1><a:srgbClr val="112233"/></a:accent1></a:clrScheme>' +
				'<a:fontScheme name="x"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
		)

		expect(parseTheme(strict).colors.get("accent1")).toBe("112233")
		expect(parseTheme(strict).font("minorHAnsi")).toBe("Aptos")
		expect(parseTheme(xml("<other/>")).colors.size).toBe(0)
	})
})

describe("colour arithmetic", () => {
	it("reproduces Word's theme tint and shade palette", () => {
		// Word's colour picker for Accent 1 of the Office theme.
		expect(applyThemeTint("4472C4", 0x33)).toBe("D9E2F3")
		expect(applyThemeTint("4472C4", 0x66)).toBe("B4C6E7")
		expect(applyThemeTint("4472C4", 0x99)).toBe("8EAADB")
		expect(applyThemeShade("4472C4", 0xbf)).toBe("2F5496")
		expect(applyThemeShade("4472C4", 0x80)).toBe("1F3864")
		expect(applyThemeShade("000000", 0x80)).toBe("000000")
		expect(applyThemeTint("FFFFFF", 0x00)).toBe("FFFFFF")
	})

	it("applies DrawingML transforms", () => {
		expect(applyColorTransforms("4472C4", [{ kind: "lumMod", value: 0.75 }])).toBe("2F5597")
		expect(
			applyColorTransforms("4472C4", [
				{ kind: "lumMod", value: 0.2 },
				{ kind: "lumOff", value: 0.8 }
			])
		).toBe("DAE3F3")
		expect(applyColorTransforms("FF0000", [{ kind: "inv" }])).toBe("00FFFF")
		expect(applyColorTransforms("FF0000", [{ kind: "comp" }])).toBe("00FFFF")
		expect(applyColorTransforms("FF0000", [{ kind: "gray" }])).toBe("4D4D4D")
		expect(applyColorTransforms("808080", [{ kind: "tint", value: 0.5 }])).toBe("CDCDCD")
		expect(applyColorTransforms("808080", [{ kind: "shade", value: 0.5 }])).toBe("5C5C5C")
		expect(applyColorTransforms("336699", [{ kind: "alpha", value: 0.5 }])).toBe("336699")
	})

	it("reads DrawingML colour elements with transforms", () => {
		const document = xml(
			`<r xmlns:a="${A}"><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr><a:srgbClr val="ff0000"><a:alpha val="50000"/></a:srgbClr>` +
				'<a:sysClr val="window"/><a:prstClr val="navy"/><a:hslClr hue="0" sat="100000" lum="50000"/><a:scrgbClr r="100000" g="0" b="0"/>' +
				'<a:srgbClr val="808080"><a:lumMod val="50%"/></a:srgbClr></r>'
		)
		const theme = parseTheme(OFFICE_THEME)
		const colors: (string | undefined)[] = []

		for (let child = document.firstChildElement(document.documentElement()); child >= 0; child = document.nextSiblingElement(child)) {
			colors.push(readDrawingColor(document, child, name => theme.schemeColor(name)))
		}

		expect(colors).toEqual(["2F5597", "FF0000", "FFFFFF", "000080", "FF0000", "FF0000", "404040"])
	})

	it("applies hue, sat, lum, component and gamma transforms as the text colour path does", () => {
		const elements =
			'<a:srgbClr val="FF0000"><a:hue val="7200000"/></a:srgbClr><a:srgbClr val="FF0000"><a:sat val="0"/></a:srgbClr>' +
			'<a:srgbClr val="FF0000"><a:lum val="100000"/></a:srgbClr><a:srgbClr val="000000"><a:green val="100000"/></a:srgbClr>' +
			'<a:srgbClr val="808080"><a:redOff val="100000"/></a:srgbClr><a:srgbClr val="808080"><a:blueMod val="50000"/></a:srgbClr>' +
			'<a:srgbClr val="808080"><a:gamma/></a:srgbClr><a:srgbClr val="808080"><a:invGamma/></a:srgbClr>' +
			'<a:schemeClr val="accent1"><a:hueMod val="50000"/><a:satOff val="-20000"/></a:schemeClr>'
		const document = xml(`<r xmlns:a="${A}">${elements}</r>`)
		const theme = parseTheme(OFFICE_THEME)
		const colors: (string | undefined)[] = []
		const expected: string[] = []
		const accent1 = theme.schemeColor("accent1") ?? ""

		for (let child = document.firstChildElement(document.documentElement()); child >= 0; child = document.nextSiblingElement(child)) {
			colors.push(readDrawingColor(document, child, name => theme.schemeColor(name)))

			const base = document.localName(child) === "schemeClr" ? accent1 : (document.attribute(child, "val") ?? "")
			const mods: ColorMod[] = []

			for (let mod = document.firstChildElement(child); mod >= 0; mod = document.nextSiblingElement(mod)) {
				const value = document.attribute(mod, "val")

				mods.push(value === undefined ? { name: document.localName(mod) } : { name: document.localName(mod), value: Number(value) })
			}

			expected.push(applyMods(base, 1, mods).hex)
		}

		expect(colors.slice(0, 4)).toEqual(["00FF00", "808080", "FFFFFF", "00FF00"])
		expect(colors).toEqual(expected)
	})

	it("flattens shading patterns", () => {
		expect(shadingColor("clear", undefined, "FFFF00")).toBe("FFFF00")
		expect(shadingColor("clear", "FF0000", undefined)).toBeUndefined()
		expect(shadingColor("solid", undefined, "FFFFFF")).toBe("000000")
		expect(shadingColor("solid", "FF0000", "FFFFFF")).toBe("FF0000")
		expect(shadingColor("pct25", undefined, undefined)).toBe("BFBFBF")
		expect(shadingColor("pct50", "000000", "FFFFFF")).toBe("808080")
		expect(shadingColor("horzStripe", "000000", "FFFFFF")).toBe("808080")
	})
})
