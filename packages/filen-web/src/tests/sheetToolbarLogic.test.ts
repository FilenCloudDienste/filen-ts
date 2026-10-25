import { describe, expect, it } from "vitest"
import { CellFlag, formatValue, numFmtCategory } from "@filen/office/core/sheet"
import { codeOf, optionsOf, TYPES, type FormatOptions } from "@/features/spreadsheet/dialogs/formatCells.logic"
import {
	activeFormat,
	alignPatch,
	decimalsPatch,
	fontGroups,
	numberLabel,
	sampleOf,
	themeSwatchRows,
	valignPatch,
	indentPatch,
	rotationPatch,
	zoomStep,
	sheetShortcutKeys,
	ORIENTATIONS
} from "@/features/spreadsheet/toolbar/toolbar.logic"
import { preview } from "@/locales/en/preview"

// The spreadsheet ribbon's and Format Cells dialog's logic: what they read from the active cell and the workbook,
// and the formats they send.

describe("spreadsheet toolbar", () => {
	it("reads the active cell's look over the workbook's default", () => {
		const format = activeFormat(
			{ bold: true, underline: "double", fill: 0xffff00, align: "center" },
			{ font: "Aptos", size: 12 },
			"0.00",
			"1.50"
		)

		expect(format).toMatchObject({
			font: "Aptos",
			size: 12,
			bold: true,
			underline: true,
			fill: 0xffff00,
			align: "center",
			valign: "bottom"
		})
		expect(activeFormat({}, {}, "General", "").font).toBe("Calibri")
	})

	it("lists the theme's fonts, then the workbook's, then common ones, each once", () => {
		const groups = fontGroups({
			themeColors: [],
			majorFont: "Calibri Light",
			minorFont: "Calibri",
			fonts: ["Calibri", "Comic Neue", "arial"]
		})

		expect(groups.map(group => group.label)).toEqual([
			"previewSheetFormatThemeFonts",
			"previewSheetFormatWorkbookFonts",
			"previewSheetFormatOtherFonts"
		])
		expect(groups[0]?.fonts).toEqual([
			{ name: "Calibri Light", theme: "headings" },
			{ name: "Calibri", theme: "body" }
		])
		expect(groups[1]?.fonts.map(font => font.name)).toEqual(["Comic Neue", "arial"])
		expect(groups[2]?.fonts.map(font => font.name)).not.toContain("Arial")
		expect(groups[2]?.fonts.map(font => font.name)).not.toContain("Calibri")
	})

	it("offers each theme colour with Excel's five tints", () => {
		const rows = themeSwatchRows([0xffffff, 0x000000, 0xe7e6e6, 0x44546a, 0x4472c4, 0xed7d31, 0xa5a5a5, 0xffc000, 0x5b9bd5, 0x70ad47])

		expect(rows).toHaveLength(6)
		expect(rows.every(row => row.length === 10)).toBe(true)
		expect(rows[0]?.[4]).toMatchObject({ rgb: "4472C4", input: { theme: 4 } })
		expect(rows[1]?.[4]?.input).toEqual({ theme: 4, tint: 0.8 })
		expect(rows[5]?.[4]?.input).toEqual({ theme: 4, tint: -0.5 })
		// White darkens, black lightens.
		expect(rows[1]?.[0]?.input).toEqual({ theme: 0, tint: -0.05 })
		expect(rows[1]?.[1]?.input).toEqual({ theme: 1, tint: 0.5 })
		expect(rows[1]?.[1]?.rgb).toBe("808080")
	})

	it("reads the cell's indent, angle (as the file writes it) and shrinking", () => {
		expect(activeFormat({ indent: 2, rotation: -45, shrink: true }, {}, "General", "")).toMatchObject({
			indent: 2,
			rotation: 135,
			shrink: true
		})
		expect(activeFormat({ rotation: 255 }, {}, "General", "").rotation).toBe(255)
		expect(activeFormat({}, {}, "General", "")).toMatchObject({ indent: 0, rotation: 0, shrink: false })
	})

	it("indents a level at a time up to Excel's 15, General and centred text turning left", () => {
		expect(indentPatch({ indent: 0, align: "general" }, 1)).toEqual({ indent: 1, align: "left" })
		expect(indentPatch({ indent: 0, align: "center" }, 1)).toEqual({ indent: 1, align: "left" })
		expect(indentPatch({ indent: 1, align: "right" }, 1)).toEqual({ indent: 2 })
		expect(indentPatch({ indent: 1, align: "left" }, -1)).toEqual({ indent: 0 })
		expect(indentPatch({ indent: 0, align: "left" }, -1)).toBeNull()
		expect(indentPatch({ indent: 15, align: "left" }, 1)).toBeNull()
	})

	it("turns the text to an angle, and back to horizontal when it is picked again", () => {
		expect(ORIENTATIONS.map(orientation => orientation.rotation)).toEqual([45, 135, 255, 90, 180])
		expect(rotationPatch(0, 45)).toEqual({ rotation: 45 })
		expect(rotationPatch(45, 45)).toEqual({ rotation: 0 })
		expect(rotationPatch(45, 180)).toEqual({ rotation: 180 })

		for (const orientation of ORIENTATIONS) {
			expect(preview).toHaveProperty(orientation.label)
		}
	})

	it("zooms by Excel's steps, held at 25% and 400%", () => {
		expect(zoomStep(100, 1)).toBe(125)
		expect(zoomStep(100, -1)).toBe(75)
		expect(zoomStep(110, -1)).toBe(100)
		expect(zoomStep(400, 1)).toBe(400)
		expect(zoomStep(25, -1)).toBe(25)
	})

	it("names a grid shortcut's keys as the platform shows them", () => {
		expect(sheetShortcutKeys("bold", false)).toEqual(["Ctrl", "B"])
		expect(sheetShortcutKeys("bold", true)).toEqual(["⌘", "B"])
		expect(sheetShortcutKeys("filter", false)).toEqual(["Ctrl", "Shift", "L"])
		expect(sheetShortcutKeys("insertCells", false)).toEqual(["Ctrl", "Shift", "="])
		expect(sheetShortcutKeys("showFormulas", true)).toEqual(["⌃", "`"])
		expect(sheetShortcutKeys("note", false)).toEqual(["Shift", "F2"])
		expect(sheetShortcutKeys("formatCells", false)).toEqual(["Ctrl", "1"])
	})

	it("clears an alignment back to the default rather than writing it", () => {
		expect(alignPatch("general")).toEqual({ align: null })
		expect(alignPatch("center")).toEqual({ align: "center" })
		expect(valignPatch("bottom")).toEqual({ valign: null })
		expect(valignPatch("top")).toEqual({ valign: "top" })
	})

	it("names the format in effect as the menu lists it", () => {
		expect(numberLabel("General")).toBe("previewSheetNumberGeneral")
		expect(numberLabel("m/d/yyyy")).toBe("previewSheetNumberShortDate")
		expect(numberLabel("[$-F800]dddd, mmmm dd, yyyy")).toBe("previewSheetNumberLongDate")
		expect(numberLabel("#,##0.0")).toBe("previewSheetNumberNumber")
		expect(numberLabel('0.0" kg"')).toBe("previewSheetNumberNumber")
		expect(numberLabel("yyyy")).toBe("previewSheetNumberDate")
		for (const key of ["previewSheetNumberGeneral", "previewSheetNumberCustom", "previewSheetNumberLongDate"] as const)
			expect(preview[key]).toBeDefined()
	})

	it("adds and takes decimal places from what a General cell shows", () => {
		expect(decimalsPatch("General", "1.25", 1, ".")).toEqual({ numFmt: "0.000" })
		expect(decimalsPatch("0.00", "1.25", -1, ".")).toEqual({ numFmt: "0.0" })
		expect(decimalsPatch("m/d/yyyy", "1/2/2024", 1, ".")).toBeNull()
	})

	it("previews a number or a date, not text or a formula", () => {
		expect(sampleOf("1234.5", CellFlag.NUMBER, false)).toBe(1234.5)
		expect(sampleOf("2023-03-15", CellFlag.NUMBER, false)).toBe(45000)
		expect(sampleOf("2023-03-15T12:00:00", CellFlag.NUMBER, false)).toBe(45000.5)
		expect(sampleOf("1900-01-01", CellFlag.NUMBER, false)).toBe(1)
		expect(sampleOf("2023-03-15", CellFlag.NUMBER, true)).toBe(45000 - 1462)
		expect(sampleOf("=A1", CellFlag.NUMBER | CellFlag.FORMULA, false)).toBeNull()
		expect(sampleOf("hello", 0, false)).toBeNull()
	})
})

describe("Format Cells dialog", () => {
	const options = (patch: Partial<FormatOptions>): FormatOptions => ({ ...optionsOf("General"), ...patch })

	it("makes Excel's codes for each category's options", () => {
		expect(codeOf(options({ category: "number", decimals: 2, thousands: true, negative: 0 }))).toBe("#,##0.00")
		expect(codeOf(options({ category: "number", decimals: 1, thousands: false, negative: 3 }))).toBe("0.0_);[Red](0.0)")
		expect(codeOf(options({ category: "currency", decimals: 2, symbol: "$", negative: 1 }))).toBe('"$"#,##0.00;[Red]"$"#,##0.00')
		expect(codeOf(options({ category: "accounting", decimals: 2, symbol: "$" }))).toBe(
			'_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'
		)
		expect(codeOf(options({ category: "accounting", decimals: 0, symbol: "" }))).toBe('_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)')
		expect(codeOf(options({ category: "percentage", decimals: 0 }))).toBe("0%")
		expect(codeOf(options({ category: "scientific", decimals: 3 }))).toBe("0.000E+00")
		expect(codeOf(options({ category: "date", type: 13 }))).toBe("yyyy-mm-dd;@")
		expect(codeOf(options({ category: "custom", code: '0.0" kg"' }))).toBe('0.0" kg"')
	})

	it("makes codes of the category they were made for", () => {
		for (const category of ["number", "currency", "accounting", "percentage", "scientific", "text", "general"] as const)
			expect(numFmtCategory(codeOf(options({ category, decimals: 2 }))), category).toBe(category)

		for (const category of ["date", "time", "fraction"] as const)
			// Excel lists a date with a time under Time too; its category is the date's.
			for (const code of TYPES[category] ?? [])
				expect(numFmtCategory(code), code).toBe(category === "time" && code.includes("m/d") ? "date" : category)
	})

	it("reads a cell's code back into the options that make it", () => {
		for (const code of ["#,##0.00", "0.0_);[Red](0.0)", '"$"#,##0.00;[Red]"$"#,##0.00', "0.00%", "0.0E+00", "m/d/yyyy", "# ?/?"])
			expect(codeOf(optionsOf(code)), code).toBe(code)

		expect(optionsOf("yyyy").category).toBe("custom")
	})

	it("shows a sample of what the chosen code makes", () => {
		expect(formatValue(1234.5, codeOf(options({ category: "number", decimals: 2, thousands: true }))).text).toBe("1,234.50")
	})
})
