import type { SheetRange } from "../protocol"
import { parseSqref } from "../../xlsx/refs/sqref"
import { booleanAttribute, childByLocal, childElements, numberAttribute, readColor, readDxf } from "../../xlsx/read/styleRecords"
import type { XlsxColor, XlsxDxf } from "../../xlsx/model/types"
import { encodeUtf8, parseXml, XmlError, type XmlDocument } from "../../xml/index"

// A sheet's conditional formats (ECMA-376 Part 1 §18.3.1.18 conditionalFormatting, §18.3.1.10 cfRule) and the
// Excel 2010 ones in the worksheet's extLst ([MS-XLSX] §2.6.2 x14:conditionalFormattings, uri
// {78C0D931-6437-407d-A8EE-F0AAD7539E65}). A data bar written in both (a 2007 rule whose extLst names an x14 rule by
// its id, [MS-XLSX] §2.6.11) is one rule with the 2010 properties.

export type CfType =
	| "expression"
	| "cellIs"
	| "colorScale"
	| "dataBar"
	| "iconSet"
	| "top10"
	| "uniqueValues"
	| "duplicateValues"
	| "containsText"
	| "notContainsText"
	| "beginsWith"
	| "endsWith"
	| "containsBlanks"
	| "notContainsBlanks"
	| "containsErrors"
	| "notContainsErrors"
	| "timePeriod"
	| "aboveAverage"

const TYPES: ReadonlySet<string> = new Set<CfType>([
	"expression",
	"cellIs",
	"colorScale",
	"dataBar",
	"iconSet",
	"top10",
	"uniqueValues",
	"duplicateValues",
	"containsText",
	"notContainsText",
	"beginsWith",
	"endsWith",
	"containsBlanks",
	"notContainsBlanks",
	"containsErrors",
	"notContainsErrors",
	"timePeriod",
	"aboveAverage"
])

// §18.18.12 ST_CfvoType, with [MS-XLSX] §2.6.75 ST_CfvoType's autoMin and autoMax.
export type CfvoType = "num" | "percent" | "max" | "min" | "formula" | "percentile" | "autoMin" | "autoMax"

export interface Cfvo {
	readonly type: CfvoType
	// The number or formula as written (xm:f in an x14 rule), null when absent.
	readonly value: string | null
	// The threshold is reached at the value itself (">="), or only above it.
	readonly gte: boolean
}

export interface CfColorScale {
	readonly cfvos: readonly Cfvo[]
	readonly colors: readonly XlsxColor[]
}

export interface CfDataBar {
	readonly min: Cfvo
	readonly max: Cfvo
	readonly color: XlsxColor
	// Percent of the cell's width the shortest and longest bars take (Excel caps both at 100, [MS-OE376] §3.3.1.26).
	readonly minLength: number
	readonly maxLength: number
	readonly showValue: boolean
	// The Excel 2010 properties ([MS-XLSX] §2.6.30 CT_DataBar); a 2007 bar has none of them.
	readonly gradient: boolean
	readonly border: XlsxColor | null
	// Negative values' bar and border (an Excel 2010 bar's own, red when it names none; a 2007 bar's are the fill's).
	readonly negativeFill: XlsxColor
	readonly negativeBorder: XlsxColor | null
	// The axis line between negative and positive bars, null for none.
	readonly axisColor: XlsxColor | null
	readonly axisPosition: "automatic" | "middle" | "none"
	readonly direction: "context" | "leftToRight" | "rightToLeft"
	// An Excel 2010 bar ([MS-XLSX] §2.6.30): negative values draw from an axis.
	readonly extended: boolean
}

export interface CfIconSet {
	// §18.18.42 ST_IconSetType, with the 2010 sets ([MS-XLSX] §2.6.81) and "NoIcons" for a custom icon left empty.
	readonly set: string
	readonly cfvos: readonly Cfvo[]
	readonly showValue: boolean
	readonly reverse: boolean
	// The thresholds are percentages (the default) or as their cfvos say.
	readonly percent: boolean
	// [MS-XLSX] §2.6.33 cfIcon: per threshold, the set and index of the icon shown instead (custom icon sets).
	readonly custom: readonly ({ readonly set: string; readonly id: number } | null)[] | null
}

export interface CfRule {
	readonly type: CfType
	readonly priority: number
	readonly stopIfTrue: boolean
	// The look applied when the rule holds (a dxf of styles.xml, or an x14 rule's own).
	readonly dxf: XlsxDxf | null
	readonly operator: string | null
	readonly formulas: readonly string[]
	readonly text: string | null
	readonly timePeriod: string | null
	readonly rank: number
	readonly percent: boolean
	readonly bottom: boolean
	readonly aboveAverage: boolean
	readonly equalAverage: boolean
	readonly stdDev: number
	readonly colorScale: CfColorScale | null
	readonly dataBar: CfDataBar | null
	readonly iconSet: CfIconSet | null
}

export interface CfBlock {
	// The cells the rules apply to; their formulas are written for the top-left cell of the rectangle around them.
	readonly ranges: readonly SheetRange[]
	readonly rules: readonly CfRule[]
}

// Bounds on what a sheet's conditional formats may hold (a hostile file): ranges per block and rules per sheet. A
// block over more ranges is not applied (its ranks over part of them would be a guess); ranges are found by
// position (ranges.ts), so a large sqref costs what it covers.
export const MAX_CF_RANGES = 100_000
export const MAX_CF_RULES = 100_000
// And on rules times the ranges each applies to, which is what preparing and applying them costs: far past what
// formatted cells copied about make (thousands of ranges, a handful of rules), short of 100_000 rules over as many.
export const MAX_CF_RULE_RANGES = 5_000_000

const DATA_BAR_EXT = "{B025F937-C7B1-47D3-B67F-A62EFF666E3E}"
const CF_EXT = "{78C0D931-6437-407D-A8EE-F0AAD7539E65}"

function textOf(document: XmlDocument, node: number): string {
	return node < 0 ? "" : document.textContent(node)
}

function cfvoOf(document: XmlDocument, node: number): Cfvo {
	const raw = document.attribute(node, "type") ?? "num"
	const type: CfvoType = (["num", "percent", "max", "min", "formula", "percentile", "autoMin", "autoMax"] as const).includes(
		raw as CfvoType
	)
		? (raw as CfvoType)
		: "num"
	// An x14 cfvo holds its value as xm:f.
	const f = childByLocal(document, node, "f")
	const value = f >= 0 ? textOf(document, f) : (document.attribute(node, "val") ?? null)

	return { type, value, gte: booleanAttribute(document, node, "gte", true) }
}

function colorOf(document: XmlDocument, node: number, local: string): XlsxColor | null {
	const child = childByLocal(document, node, local)

	return child < 0 ? null : readColor(document, child)
}

function colorScaleOf(document: XmlDocument, node: number): CfColorScale {
	const cfvos: Cfvo[] = []
	const colors: XlsxColor[] = []

	for (const child of childElements(document, node)) {
		const local = document.localName(child)

		if (local === "cfvo") cfvos.push(cfvoOf(document, child))
		else if (local === "color") colors.push(readColor(document, child))
	}

	return { cfvos, colors }
}

function dataBarOf(document: XmlDocument, node: number, extended: boolean): CfDataBar {
	const cfvos: Cfvo[] = []

	for (const child of childElements(document, node)) if (document.localName(child) === "cfvo") cfvos.push(cfvoOf(document, child))

	const direction = document.attribute(node, "direction")
	const fill = colorOf(document, node, "fillColor") ?? colorOf(document, node, "color") ?? { argb: 0xff638ec6 }
	const border = extended && booleanAttribute(document, node, "border", false) ? (colorOf(document, node, "borderColor") ?? fill) : null
	const negativeSame = !extended || booleanAttribute(document, node, "negativeBarColorSameAsPositive", false)
	const negativeBorderSame = booleanAttribute(document, node, "negativeBarBorderColorSameAsPositive", true)
	const axis = document.attribute(node, "axisPosition")

	return {
		min: cfvos[0] ?? { type: extended ? "autoMin" : "min", value: null, gte: true },
		max: cfvos[1] ?? { type: extended ? "autoMax" : "max", value: null, gte: true },
		color: fill,
		minLength: Math.max(0, Math.min(100, numberAttribute(document, node, "minLength") ?? 10)),
		maxLength: Math.max(0, Math.min(100, numberAttribute(document, node, "maxLength") ?? 90)),
		showValue: booleanAttribute(document, node, "showValue", true),
		gradient: extended ? booleanAttribute(document, node, "gradient", true) : true,
		border,
		negativeFill: negativeSame ? fill : (colorOf(document, node, "negativeFillColor") ?? { argb: 0xffff0000 }),
		negativeBorder:
			border === null ? null : negativeBorderSame ? border : (colorOf(document, node, "negativeBorderColor") ?? { argb: 0xffff0000 }),
		axisColor: !extended || axis === "none" ? null : (colorOf(document, node, "axisColor") ?? { argb: 0xff000000 }),
		axisPosition: !extended ? "none" : axis === "middle" || axis === "none" ? axis : "automatic",
		direction: direction === "leftToRight" || direction === "rightToLeft" ? direction : "context",
		extended
	}
}

function iconSetOf(document: XmlDocument, node: number): CfIconSet {
	const cfvos: Cfvo[] = []
	const custom: ({ set: string; id: number } | null)[] = []
	let anyCustom = false

	for (const child of childElements(document, node)) {
		const local = document.localName(child)

		if (local === "cfvo") {
			cfvos.push(cfvoOf(document, child))
		} else if (local === "cfIcon") {
			anyCustom = true
			custom.push({ set: document.attribute(child, "iconSet") ?? "NoIcons", id: numberAttribute(document, child, "iconId") ?? 0 })
		}
	}

	return {
		set: document.attribute(node, "iconSet") ?? "3TrafficLights1",
		cfvos,
		showValue: booleanAttribute(document, node, "showValue", true),
		reverse: booleanAttribute(document, node, "reverse", false),
		percent: booleanAttribute(document, node, "percent", true),
		custom: anyCustom && booleanAttribute(document, node, "custom", true) ? custom : null
	}
}

interface RuleContext {
	readonly dxfs: readonly XlsxDxf[]
	// x14 rules by id, for the 2007 data bars that name them.
	readonly extended: ReadonlyMap<string, { readonly document: XmlDocument; readonly node: number }>
	readonly used: Set<string>
}

function ruleOf(document: XmlDocument, node: number, context: RuleContext, x14: boolean): CfRule | null {
	const type = document.attribute(node, "type") ?? ""

	if (!TYPES.has(type)) return null

	const formulas: string[] = []
	let dxf: XlsxDxf | null = null
	let colorScale: CfColorScale | null = null
	let dataBar: CfDataBar | null = null
	let iconSet: CfIconSet | null = null

	if (!x14) {
		const id = numberAttribute(document, node, "dxfId")

		if (id !== undefined) dxf = context.dxfs[id] ?? null
	}

	for (const child of childElements(document, node)) {
		switch (document.localName(child)) {
			case "formula":
			case "f":
				formulas.push(textOf(document, child))
				break
			case "dxf":
				dxf = readDxf(document, child)
				break
			case "colorScale":
				colorScale = colorScaleOf(document, child)
				break
			case "dataBar":
				dataBar = dataBarOf(document, child, x14)
				break
			case "iconSet":
				iconSet = iconSetOf(document, child)
				break
			case "extLst":
				// A 2007 data bar's Excel 2010 properties live in the x14 rule its id names.
				for (const ext of childElements(document, child)) {
					if ((document.attribute(ext, "uri") ?? "").toUpperCase() !== DATA_BAR_EXT) continue

					const idNode = childByLocal(document, ext, "id")
					const id = textOf(document, idNode).trim().toUpperCase()
					const target = context.extended.get(id)

					if (target === undefined) continue

					const bar = childByLocal(target.document, target.node, "dataBar")

					if (bar >= 0) {
						dataBar = dataBarOf(target.document, bar, true)
						context.used.add(id)
					}
				}
				break
		}
	}

	return {
		type: type as CfType,
		priority: numberAttribute(document, node, "priority") ?? Number.MAX_SAFE_INTEGER,
		stopIfTrue: booleanAttribute(document, node, "stopIfTrue", false),
		dxf,
		operator: document.attribute(node, "operator") ?? null,
		formulas,
		text: document.attribute(node, "text") ?? null,
		timePeriod: document.attribute(node, "timePeriod") ?? null,
		rank: numberAttribute(document, node, "rank") ?? 10,
		percent: booleanAttribute(document, node, "percent", false),
		bottom: booleanAttribute(document, node, "bottom", false),
		aboveAverage: booleanAttribute(document, node, "aboveAverage", true),
		equalAverage: booleanAttribute(document, node, "equalAverage", false),
		stdDev: numberAttribute(document, node, "stdDev") ?? 0,
		colorScale,
		dataBar,
		iconSet
	}
}

// Section markup (one or more elements) under a root of its own, null when it does not parse (validations read theirs
// so too).
export function parseSections(markup: string): XmlDocument | null {
	try {
		return parseXml(encodeUtf8(`<sections>${markup}</sections>`))
	} catch (error) {
		if (error instanceof XmlError) return null

		throw error
	}
}

function rangesOf(text: string): SheetRange[] {
	const ranges = parseSqref(text) ?? []

	return ranges.length > MAX_CF_RANGES ? [] : ranges
}

// The conditional formats of a sheet from its conditionalFormatting sections and its extLst (markup as written,
// any number of elements each), 2007 blocks before x14 ones. Malformed sections and rules of unknown types show
// nothing.
export function readConditionalFormats(sections: readonly string[], extLst: string | null, dxfs: readonly XlsxDxf[]): CfBlock[] {
	const extended = new Map<string, { document: XmlDocument; node: number }>()
	const x14Blocks: { document: XmlDocument; node: number }[] = []
	const extDocument = extLst === null ? null : parseSections(extLst)

	for (const extList of extDocument === null ? [] : childElements(extDocument, extDocument.documentElement())) {
		if (extDocument === null || extDocument.localName(extList) !== "extLst") continue

		for (const ext of childElements(extDocument, extList)) {
			if ((extDocument.attribute(ext, "uri") ?? "").toUpperCase() !== CF_EXT) continue

			const list = childByLocal(extDocument, ext, "conditionalFormattings")

			for (const block of list < 0 ? [] : childElements(extDocument, list)) {
				if (extDocument.localName(block) !== "conditionalFormatting") continue

				x14Blocks.push({ document: extDocument, node: block })

				for (const rule of childElements(extDocument, block)) {
					const id = extDocument.attribute(rule, "id")

					if (extDocument.localName(rule) === "cfRule" && id !== undefined)
						extended.set(id.trim().toUpperCase(), { document: extDocument, node: rule })
				}
			}
		}
	}

	const context: RuleContext = { dxfs, extended, used: new Set() }
	const blocks: CfBlock[] = []
	let count = 0
	// Rules read so far times their ranges.
	let work = 0

	for (const { document, root } of sections.flatMap(markup => {
		const document = parseSections(markup)

		return document === null ? [] : [...childElements(document, document.documentElement())].map(root => ({ document, root }))
	})) {
		if (document.localName(root) !== "conditionalFormatting") continue

		const rules: CfRule[] = []
		const ranges = rangesOf(document.attribute(root, "sqref") ?? "")

		for (const child of childElements(document, root)) {
			if (document.localName(child) !== "cfRule" || count >= MAX_CF_RULES || work + ranges.length > MAX_CF_RULE_RANGES) continue

			const rule = ruleOf(document, child, context, false)

			if (rule !== null) {
				rules.push(rule)
				count++
				work += ranges.length
			}
		}

		if (rules.length > 0 && ranges.length > 0) blocks.push({ ranges, rules })
	}

	for (const { document, node } of x14Blocks) {
		const rules: CfRule[] = []
		const sqref = childByLocal(document, node, "sqref")
		const ranges = rangesOf(textOf(document, sqref))

		for (const child of childElements(document, node)) {
			if (document.localName(child) !== "cfRule" || count >= MAX_CF_RULES || work + ranges.length > MAX_CF_RULE_RANGES) continue

			const id = document.attribute(child, "id")?.trim().toUpperCase()

			// Already the 2010 half of a 2007 data bar.
			if (id !== undefined && context.used.has(id)) continue

			const rule = ruleOf(document, child, context, true)

			if (rule !== null) {
				rules.push(rule)
				count++
				work += ranges.length
			}
		}

		if (rules.length > 0 && ranges.length > 0) blocks.push({ ranges, rules })
	}

	return blocks
}
