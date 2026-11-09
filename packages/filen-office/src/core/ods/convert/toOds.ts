import { appendAll, spliceAll } from "../../arrays"
import { BytePieces, bytesSource, memorySink, resolvePartName, writeZip } from "../../opc/index"
import { runSliced, type SliceClock } from "../../slicing"
import { RenderStyleTable } from "../../sheet/session"
import type { SheetStyles } from "../../sheet/style/resolve"
import { dateSerial, type DateBase } from "../../sheet/numfmt/date"
import { decodeCharacterData, decodeUtf8, encodeUtf8, escapeAttribute } from "../../xml/index"
import { encodeXstring, XlsxDocument } from "../../xlsx/edit/document"
import { decodeXstring, SheetStrings } from "../../xlsx/model/strings"
import { openXlsx } from "../../xlsx/package/open"
import { XlsxReadError } from "../../xlsx/read/errors"
import { FormulaTable } from "../../xlsx/model/formulas"
import { SheetStore, type CellWrite, type RowProperties } from "../../xlsx/model/store"
import { XlsxSheet } from "../../xlsx/read/index"
import { Relationships } from "../../opc/relationships"
import { partRelationships } from "../../xlsx/charts/parts"
import type { XlsxWorkbook } from "../../xlsx/model/workbook"
import {
	CellKind,
	ColFlag,
	FormulaKind,
	RowFlag,
	type XlsxBorder,
	type XlsxColRange,
	type XlsxRowRun,
	type XlsxBorderEdge,
	type XlsxDefinedName,
	type XlsxFill,
	type XlsxFont,
	type XlsxRichRun,
	type XlsxSection,
	type XlsxSheetModel,
	type XlsxSheetEntry,
	type XlsxStyleTable,
	type XlsxXf
} from "../../xlsx/model/types"
import { cellRef, columnName, parseRangeRef } from "../../xlsx/write/text"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetProtectedAction, type SheetRange } from "../../sheet/protocol"
import { OdfNs } from "../../odf/namespaces"
import { openFormula } from "../formula/toOf"
import { openOds } from "../open"
import { odsSource, setOdsSource, type OdsSource } from "../source"
import { saveOds } from "../write/save"
import { printRanges } from "../write/content"
import { filterRange, FilterRefused } from "../write/filters"
import { NameRefused, namesPlan } from "../write/names"
import { sheetValidationsSteps, ValidationRefused } from "../write/validations"
import { dataStyles, sameShown } from "../write/dataStyle"
import { cellStyleProperties } from "../write/styles"
import { paragraphText, STRICT_ERRORS } from "../write/cells"
import { tagParts, templateLocale } from "../../templates/locale"
import { SheetLossyReport, type SheetLossyKind } from "./report"
import { readSheetTable, resolveStructured, sheetErrorsAsErrors, type SheetTable } from "./structured"
import { ConditionStyles, sheetConditions } from "./conditional"
import { PageStyles, type SheetPageMarkup } from "./page"
import { sheetRef } from "../formula/toXlsx"
import { DrawingRefused, PackageFiles, sheetFrames } from "./drawings"
import { ShapeStyles } from "./shapes"
import { relationshipKind } from "../../xlsx/comments/parts"
import { workbookDrawingTheme } from "../../xlsx/drawings/render"
import { SheetView } from "../write/sheet"
import type { NewTable, TitleSpan } from "../write/table"
import { abortClock, aborted, showsDate, type SheetConversion, type SheetConvertOptions } from "./types"

// A SpreadsheetML workbook as an OpenDocument spreadsheet: the workbook read into its model, made into what the
// OpenDocument writer holds (shared formulas each written out, formulas OpenFormula cannot say left as their cached
// results, formats reduced to what a cell style can say), and written by that writer as new tables into an empty
// package of its own, whose save reads the file back and compares it with the model. What the writer does not
// write is reported by kind.

const MEDIA_TYPE = "application/vnd.oasis.opendocument.spreadsheet"
const CHART_MEDIA_TYPE = "application/vnd.oasis.opendocument.chart"

// Sheet sections the OpenDocument writer writes (or that hold nothing of their own to lose).
const WRITTEN_SECTIONS: ReadonlySet<string> = new Set([
	"sheetPr",
	"dimension",
	"sheetViews",
	"sheetFormatPr",
	"cols",
	"sheetData",
	"sheetProtection",
	"mergeCells",
	"hyperlinks",
	"dataValidations",
	"autoFilter",
	// The notes' shapes: the notes are written from their comments part.
	"legacyDrawing",
	// Drawings are counted from their part.
	"drawing",
	// How a calculation goes, not what it gives.
	"sheetCalcPr"
])
// What a protected sheet may still allow in an OpenDocument file (loext:table-protection).
const PROTECTION_ALLOWS: ReadonlySet<SheetProtectedAction> = new Set<SheetProtectedAction>([
	"selectLockedCells",
	"selectUnlockedCells",
	"insertColumns",
	"insertRows",
	"deleteColumns",
	"deleteRows"
])
// The sections the writer reads markup of (sectionText).
const READ_SECTIONS: ReadonlySet<string> = new Set(["hyperlinks", "dataValidations", "autoFilter"])
// The sections a sheet's page is read from (page.ts).
const PAGE_SECTIONS: ReadonlySet<string> = new Set(["printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks"])
const SECTION_KINDS: Readonly<Record<string, SheetLossyKind>> = {
	conditionalFormatting: "conditionalFormat",
	tableParts: "table",
	sortState: "filter",
	picture: "picture",
	oleObjects: "picture",
	controls: "picture"
}
function attr(name: string, value: string): string {
	return ` ${name}="${escapeAttribute(value)}"`
}

function count(text: string, pattern: RegExp): number {
	return [...text.matchAll(pattern)].length
}

// --- Sections ---

// The root's namespace declarations, given to a section's first element where it lacks them (the writer parses a
// section on its own).
function declared(section: string, root: string): string {
	const declarations = [...root.matchAll(/\sxmlns(?::[\w.-]+)?="[^"]*"/g)].map(match => match[0])
	const open = /^(\s*<[^\s/>]+)/.exec(section)

	if (open === null) return section

	const tagEnd = section.indexOf(">")
	const tag = section.slice(0, tagEnd)
	const missing = declarations.filter(declaration => !tag.includes(declaration.trim().split("=")[0] ?? ""))

	return `${open[1] ?? ""}${missing.join("")}${section.slice((open[1] ?? "").length)}`
}

// Links on cells holding a formula or no text left out (reported): an OpenDocument cell's link is a text:a of its own
// text, which a formula's result is not.
function withoutFormulaLinks(markup: string, model: XlsxSheetModel, sheet: string, report: SheetLossyReport): string {
	const store = model.store as SheetStore
	let lost = 0
	const kept = markup.replace(/<(?:\w+:)?hyperlink\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?hyperlink>)/g, link => {
		const range = parseRangeRef(/\sref="([^"]*)"/.exec(link)?.[1] ?? "")
		let formula = false
		let text = false

		if (range !== null && range !== undefined)
			store.forEachCell(range, (_row, _col, slot) => {
				formula ||= store.formula(slot) >= 0
				text ||= store.kind(slot) !== CellKind.EMPTY
			})

		// Nor has a cell without text one (LibreOffice drops such a link too; an empty field shows as a space).
		if (formula || !text) {
			lost++

			return ""
		}

		// A link over a merged range is its first cell's: the others are covered, and hold nothing (§9.1.5).
		const merge = range === null || range === undefined ? -1 : mergeAt(model.merges, range)

		return merge < 0 ? link : link.replace(/\sref="[^"]*"/, ` ref="${cellRef(model.merges[merge] ?? 0, model.merges[merge + 1] ?? 0)}"`)
	})

	report.note("other", sheet, lost)

	return kept
}

// The merge (its index in the quads) whose range is exactly `range`, -1 for none.
function mergeAt(merges: Uint32Array, range: SheetRange): number {
	for (let k = 0; k + 3 < merges.length; k += 4)
		if (
			merges[k] === range.startRow &&
			merges[k + 1] === range.startCol &&
			merges[k + 2] === range.endRow &&
			merges[k + 3] === range.endCol
		)
			return k

	return -1
}

function extensionKinds(markup: string): SheetLossyKind[] {
	const kinds: SheetLossyKind[] = []

	if (/conditionalFormattings?\b/.test(markup)) kinds.push("conditionalFormat")
	if (/dataValidations\b/.test(markup)) kinds.push("dataValidation")
	if (/sparklineGroups\b/.test(markup)) kinds.push("sparkline")
	if (/slicerList\b|timelineRefs\b/.test(markup)) kinds.push("filter")
	if (kinds.length === 0 && /<(?:\w+:)?ext\b/.test(markup)) kinds.push("other")

	return kinds
}

interface SheetPrep {
	readonly entry: XlsxWorkbook["sheets"][number]
	readonly model: XlsxSheetModel
}

// Each section's markup as the writer reads it; what it does not write, reported.
async function prepareSections(
	workbook: XlsxWorkbook,
	prep: SheetPrep,
	report: SheetLossyReport,
	comments: Map<string, Uint8Array>,
	tables: Map<string, SheetTable>,
	conditions: Map<number, string[]>,
	pages: Map<number, Record<keyof SheetPageMarkup, string>>,
	sheetTables: Map<number, SheetTablePart[]>,
	drawings: Map<number, string>
): Promise<void> {
	const { entry, model } = prep
	const part = await workbook.parts.read(entry.part)
	const bounds = model as XlsxSheetModel & { readonly rootStart?: number; readonly rootOpenEnd?: number }
	const root = decodeUtf8(part.subarray(bounds.rootStart ?? 0, bounds.rootOpenEnd ?? 0))
	const sections: XlsxSection[] = []
	const page: Record<keyof SheetPageMarkup, string> = {
		pageSetup: "",
		pageMargins: "",
		printOptions: "",
		headerFooter: "",
		rowBreaks: "",
		colBreaks: "",
		sheetPr: ""
	}

	pages.set(entry.id, page)

	for (const section of model.sections) {
		const bytes = section.bytes ?? part.subarray(section.start, section.end)
		const markup = decodeUtf8(bytes)

		if (READ_SECTIONS.has(section.name)) {
			// Excel's revision ids (xr:uid, [MS-XLSX] revisions) say nothing a table:content-validation holds.
			// An operator means nothing on a rule that compares no value (any value, list, custom), nor the drop-down
			// on any rule but a list (ECMA-376 Part 1 §18.3.1.32): OpenDocument holds neither.
			const own =
				section.name === "dataValidations"
					? markup
							.replace(/\s[\w.-]+:uid="[^"]*"/g, "")
							.replace(/<(?:\w+:)?dataValidation\b[^>]*>/g, tag =>
								(/\stype="(?:whole|decimal|date|time|textLength)"/.test(tag)
									? tag
									: tag.replace(/\soperator="[^"]*"/, "")
								).replace(/\sshowDropDown="[^"]*"/, drop => (/\stype="list"/.test(tag) ? drop : ""))
							)
					: section.name === "hyperlinks"
						? withoutFormulaLinks(markup, model, entry.name, report)
						: markup

			sections.push({ ...section, bytes: encodeUtf8(declared(own, root)) })

			continue
		}

		sections.push(section)

		if (PAGE_SECTIONS.has(section.name)) {
			page[section.name as keyof SheetPageMarkup] = markup

			continue
		}

		// Header and footer pictures (ECMA-376 Part 1 §18.3.1.48): a header holds no picture here.
		if (section.name === "legacyDrawingHF") {
			report.note("pageSetup", entry.name)

			continue
		}

		if (section.name === "conditionalFormatting") {
			const list = conditions.get(entry.id)

			if (list === undefined) conditions.set(entry.id, [declared(markup, root)])
			else list.push(declared(markup, root))

			continue
		}

		// Each table a database range (sheetTables).
		if (section.name === "tableParts") continue

		if (section.name === "extLst") {
			for (const kind of extensionKinds(markup)) report.note(kind, entry.name)

			continue
		}

		if (section.name === "sheetPr") {
			page.sheetPr = markup

			continue
		}

		if (WRITTEN_SECTIONS.has(section.name)) continue

		report.note(SECTION_KINDS[section.name] ?? "other", entry.name)
	}

	;(model as { sections: readonly XlsxSection[] }).sections = sections

	// Drawings: charts and every other object, which the writer does not write.
	const relationships = model.relationships.all

	for (const relationship of relationships) {
		if (relationship.external) continue

		const target = relationship.partName ?? resolvePartName(entry.part, relationship.target)

		if (target === undefined) continue

		// Transitional or Strict, by the type's last segment.
		const kind = relationshipKind(relationship.type)

		if (kind === "table") {
			const bytes = workbook.parts.get(target) === undefined ? null : await workbook.parts.read(target)
			const table = bytes === null ? null : readSheetTable(bytes, entry.name)

			if (bytes === null || table === null) {
				report.note("table", entry.name)

				continue
			}

			tables.set(table.name.toUpperCase(), table)

			const text = decodeUtf8(bytes)
			const filter = /<(?:\w+:)?autoFilter\b[^>]*\/>|<(?:\w+:)?autoFilter\b[\s\S]*?<\/(?:\w+:)?autoFilter>/.exec(text)?.[0] ?? null
			const root = /<(?:\w+:)?table\b[^>]*>/.exec(text)?.[0] ?? ""
			const list = sheetTables.get(entry.id) ?? []

			list.push({
				table,
				filter: filter === null ? null : declared(filter, root),
				styled: /<(?:\w+:)?tableStyleInfo\b[^>]*\sname="[^"]/.test(text)
			})
			sheetTables.set(entry.id, list)

			continue
		}

		if (kind === "comments") {
			if (workbook.parts.get(target) !== undefined) comments.set(target, await workbook.parts.read(target))

			continue
		}

		// The drawing, its objects as frames (drawings.ts).
		if (kind === "drawing" && workbook.parts.get(target) !== undefined) drawings.set(entry.id, target)
	}
}

// --- Formulas and cells ---

// Runs with the white space a paragraph writes as elements (text:tab, text:s; ODF 1.3 Part 3 §6.1.3, §6.1.4) in runs
// of their own, the cell's: LibreOffice 7.5 drops those elements inside a span (it writes them outside one).
function bareSpacing(runs: readonly XlsxRichRun[]): XlsxRichRun[] {
	const out: XlsxRichRun[] = []

	for (const run of runs) {
		if (run.font === null) {
			out.push(run)

			continue
		}

		run.text.split("\n").forEach((line, k) => {
			if (k > 0) out.push({ text: "\n", font: run.font })

			for (const segment of paragraphText(decodeXstring(line)).split(/(<text:tab\/>|<text:s(?: text:c="\d+")?\/>)/)) {
				if (segment === "") continue
				if (segment === "<text:tab/>") out.push({ text: "\t", font: null })
				else if (segment.startsWith("<text:s"))
					out.push({ text: " ".repeat(Number(/c="(\d+)"/.exec(segment)?.[1] ?? "1")), font: null })
				else out.push({ text: encodeXstring(decodeEntities(segment)), font: run.font })
			}
		})
	}

	return out
}

function decodeEntities(markup: string): string {
	return markup.replace(
		/&(lt|gt|amp|quot|apos);/g,
		(_all, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name] ?? ""
	)
}

// Runs as paragraphs hold them: a line end is where one paragraph ends and the next begins, which carries no look of
// its own (text:p, ODF 1.3 Part 3 §5.1.3), so the line ends a run starts with go to the run before it (those before any text
// to the cell's own, no span's); runs alike are one span.
function paragraphRuns(runs: readonly XlsxRichRun[]): XlsxRichRun[] {
	const out: XlsxRichRun[] = []

	for (const run of runs) {
		const previous = out[out.length - 1]
		const breaks = /^\n*/.exec(run.text)?.[0].length ?? 0

		// A run of no text shows nothing.
		if (run.text === "") continue

		if (previous !== undefined && JSON.stringify(previous.font) === JSON.stringify(run.font)) {
			out[out.length - 1] = { text: previous.text + run.text, font: previous.font }

			continue
		}

		// Empty paragraphs before the first text are the cell's own, not a span's.
		if (previous === undefined && breaks > 0 && run.font !== null) {
			out.push({ text: run.text.slice(0, breaks), font: null })

			if (breaks < run.text.length) out.push({ text: run.text.slice(breaks), font: run.font })

			continue
		}

		if (previous === undefined || breaks === 0) {
			out.push(run)

			continue
		}

		out[out.length - 1] = { text: previous.text + run.text.slice(0, breaks), font: previous.font }

		if (breaks < run.text.length) out.push({ text: run.text.slice(breaks), font: run.font })
	}

	return out
}

// A cell's text (as the store holds it, with Excel's _xHHHH_ escapes) as a paragraph can hold it: a character XML 1.0
// cannot hold (§2.2) is left out, and so is a carriage return, which a paragraph's white space collapses (ODF 1.3
// Part 3 §6.1.2; before a line feed the line still ends there). Either is reported (`lost`).
function xmlText(stored: string, lost: { value: boolean }): string {
	const text = decodeXstring(stored)
	let first = -1

	for (let k = 0; k < text.length && first < 0; k++) if (!xmlCharacter(text.charCodeAt(k))) first = k

	if (first < 0) return stored

	let kept = text.slice(0, first)

	for (let k = first; k < text.length; k++) {
		const code = text.charCodeAt(k)

		if (xmlCharacter(code)) kept += text[k] ?? ""
		else lost.value = true
	}

	return encodeXstring(kept)
}

// A UTF-16 code unit XML 1.0 holds in text (§2.2) and a paragraph keeps (a carriage return it does not).
function xmlCharacter(code: number): boolean {
	return (code >= 0x20 || code === 0x09 || code === 0x0a) && code !== 0xfffe && code !== 0xffff
}

// A run's font as a span's text style holds it and the reader takes it back (styles/cell.ts textFont): what it shows
// only, colours as RGB. Outline, shadow, condensed and extended text are left out (reported).
function runFont(font: XlsxFont, colorOf: (color: NonNullable<XlsxFont["color"]>) => number, lost: { value: boolean }): XlsxFont {
	const out: { -readonly [K in keyof XlsxFont]: XlsxFont[K] } = {}

	if (font.name !== undefined) out.name = font.name
	if (font.size !== undefined) out.size = font.size
	if (font.bold === true) out.bold = true
	if (font.italic === true) out.italic = true
	if (font.underline !== undefined && font.underline !== "none") out.underline = font.underline.startsWith("double") ? "double" : "single"
	if (font.strike === true) out.strike = true

	const color = font.color === undefined || font.color.auto === true ? -1 : colorOf(font.color)

	if (color >= 0) out.color = { argb: (0xff000000 | color) >>> 0 }
	if (font.vertAlign === "superscript" || font.vertAlign === "subscript") out.vertAlign = font.vertAlign
	if (font.outline === true || font.shadow === true || font.condense === true || font.extend === true) lost.value = true

	return out
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/

// Every formula as OpenFormula can say it: shared ones written out at each cell, those it cannot say (and data
// tables) left as their cached results and reported; t="d" dates as serials; dates before 1900-03-01 a day on (the
// 1900 date system counts a 1900-02-29, ECMA-376 Part 1 §18.17.4.1; OpenDocument does not).
async function prepareCells(
	workbook: XlsxWorkbook,
	prep: SheetPrep,
	report: SheetLossyReport,
	clock: SliceClock | undefined,
	dateCells: (xf: number) => boolean,
	colorOf: (color: NonNullable<XlsxFont["color"]>) => number,
	richStrings: Map<number, number>,
	dropped: ReadonlySet<string>,
	tables: ReadonlyMap<string, SheetTable>
): Promise<void> {
	const { entry, model } = prep
	const store = model.store as SheetStore
	const formulas = store.formulas as unknown as FormulaTable
	const expanded = new Map<number, string>()
	const values: CellWrite[] = []
	const base: DateBase = workbook.date1904

	for (const block of store.blocks) {
		for (let index = 0; index < block.rowCount; index++) {
			const row = block.firstRow + (block.rows[index] ?? 0)
			const end = block.rowStarts[index + 1] ?? 0

			for (let k = block.rowStarts[index] ?? 0; k < end; k++) {
				const col = block.cols[k] ?? 0
				const kind = block.kinds[k] as CellKind
				const id = block.formulas?.[k] ?? -1
				const style = block.styles[k] ?? 0
				let value = block.values[k] ?? 0
				let cellKind = kind
				let changed = false

				if (kind === CellKind.SHARED_STRING) {
					let index = richStrings.get(value)

					if (index === undefined) {
						const strings = workbook.sharedStrings
						const lost = { value: false }
						const text = xmlText(strings.text(value), lost)

						if (strings.isRich(value)) {
							const looks = { value: false }
							const runs = paragraphRuns(
								bareSpacing(
									(strings.runs(value) ?? []).map(run => ({
										text: xmlText(run.text, lost),
										font: run.font === null ? null : runFont(run.font, colorOf, looks)
									}))
								)
							)

							index = strings.append(text, runs)

							if (looks.value) report.note("richText", entry.name)
						} else index = text === strings.text(value) ? value : strings.append(text)

						if (lost.value) report.note("other", entry.name)

						richStrings.set(value, index)
					}

					if (index !== value) {
						value = index
						changed = true
					}
				} else if (kind === CellKind.INLINE_STRING || kind === CellKind.FORMULA_STRING) {
					const lost = { value: false }
					const before = store.strings.text(value)
					const text = xmlText(before, lost)

					if (text !== before) {
						value = store.strings.intern(text)
						changed = true
					}

					if (lost.value) report.note("other", entry.name)
				}

				if (kind === CellKind.DATE) {
					const match = DATE_TEXT.exec(store.strings.text(value))

					if (match === null) {
						report.note("other", entry.name)

						continue
					}

					const day = dateSerial(Number(match[1] ?? 0), Number(match[2] ?? 1), Number(match[3] ?? 1), base)
					const seconds = Number(match[4] ?? "0") * 3600 + Number(match[5] ?? "0") * 60 + Number(match[6] ?? "0")

					value = day + seconds / 86400
					cellKind = CellKind.NUMBER
					changed = true
				}

				if (cellKind === CellKind.NUMBER && !base && value >= 1 && value < 61 && dateCells(style)) {
					if (value >= 60) report.note("other", entry.name)
					else {
						value += 1
						changed = true
					}
				}

				let formula = id

				if (id >= 0) {
					const formulaKind = formulas.kind(id)
					const text = formulaKind === FormulaKind.SHARED_CHILD ? formulas.expanded(id, row, col) : formulas.text(id)
					let said = text
					let written =
						formulaKind === FormulaKind.DATA_TABLE
							? { refused: "data table" }
							: namesAny(text, dropped)
								? { refused: "a name not written" }
								: openFormula(text)

					// What OpenFormula has no form for but names the same cells: a structured reference as its range, a
					// sheet's #REF! as #REF! (as LibreOffice reads them).
					if ("refused" in written && formulaKind !== FormulaKind.DATA_TABLE && !namesAny(text, dropped)) {
						const plain = sheetErrorsAsErrors(text)
						const resolved = resolveStructured(plain, tables, { sheet: entry.name, row, col }) ?? plain
						const again = resolved === text ? written : openFormula(resolved)

						if (!("refused" in again)) {
							said = resolved
							written = again
						}
					}

					if ("refused" in written) {
						const shown =
							formulaKind === FormulaKind.DATA_TABLE
								? `TABLE(${formulas.formula(id).r1 ?? ""},${formulas.formula(id).r2 ?? ""})`
								: text

						report.formula(entry.name, cellRef(row, col), shown)
						formula = -1
						changed = true
					} else if (formulaKind === FormulaKind.SHARED_CHILD || formulaKind === FormulaKind.SHARED_MASTER || said !== text) {
						expanded.set(id, said)
					}
				}

				// An error with no formula left that OpenFormula has no name for (#NULL!, #SPILL!, #CALC!...): its text,
				// reported (an ODF error is a formula of that error alone, STRICT_ERRORS).
				if (cellKind === CellKind.ERROR && formula < 0 && !STRICT_ERRORS.has(store.strings.text(value))) {
					cellKind = CellKind.INLINE_STRING
					changed = true
					report.note("other", entry.name)
				}

				if (changed) values.push({ row, col, kind: cellKind, value, style, formula, origin: -1 })
			}

			if (clock?.due === true) await clock.pause()
		}
	}

	for (const [id, text] of expanded) {
		const formula = formulas.formula(id)

		formulas.set(
			id,
			formula.kind === FormulaKind.ARRAY
				? { ...formula, text }
				: { ...formula, kind: FormulaKind.NORMAL, text, sharedIndex: -1, ref: null }
		)
	}

	store.setCells(values)
}

// --- Formats ---

const BORDER_STYLES: ReadonlySet<string> = new Set([
	"thin",
	"medium",
	"thick",
	"double",
	"dotted",
	"dashed",
	"mediumDashed",
	"dashDot",
	"mediumDashDot",
	"dashDotDot",
	"mediumDashDotDot"
])

function edge(line: XlsxBorderEdge | undefined, lost: { value: boolean }): XlsxBorderEdge | undefined {
	if (line === undefined || line.style === undefined || BORDER_STYLES.has(line.style)) return line

	lost.value = true

	return { ...line, style: line.style === "slantDashDot" ? "mediumDashDot" : "thin" }
}

// The formats the cells use as a cell style can say them (ODF 1.3 Part 3 §20): a pattern fill as its solid colour,
// alignments ODF has no value for as their nearest, a border line as the nearest it draws, accounting underlines as
// plain ones, number formats a data style cannot say as General. Each format so changed is reported once.
function prepareStyles(styles: XlsxStyleTable, used: ReadonlySet<number>, report: SheetLossyReport): void {
	const fills = styles.fills as XlsxFill[]
	const borders = styles.borders as XlsxBorder[]
	const fonts = styles.fonts as XlsxFont[]
	const xfs = styles.cellXfs as XlsxXf[]
	const fixedFills = new Set<number>()
	const fixedBorders = new Set<number>()
	const fixedFonts = new Set<number>()

	for (const index of used) {
		const xf = xfs[index]

		if (xf === undefined) continue

		let lost = false
		const fill = fills[xf.fillId]

		if (fill !== undefined && fill.kind === "pattern" && fill.pattern !== "none" && fill.pattern !== "solid") {
			if (!fixedFills.has(xf.fillId)) {
				const color = fill.bg ?? fill.fg
				fills[xf.fillId] =
					color === undefined ? { kind: "pattern", pattern: "none" } : { kind: "pattern", pattern: "solid", fg: color }
				fixedFills.add(xf.fillId)
			}

			lost = true
		} else if (fixedFills.has(xf.fillId)) lost = true

		const border = borders[xf.borderId]

		if (border !== undefined && !fixedBorders.has(xf.borderId)) {
			const changed = { value: false }
			const next: { -readonly [K in keyof XlsxBorder]: XlsxBorder[K] } = { ...border }

			for (const side of ["left", "right", "top", "bottom", "diagonal"] as const) {
				const line = edge(border[side], changed)

				if (line !== undefined) next[side] = line
			}

			if (changed.value) {
				borders[xf.borderId] = next
				fixedBorders.add(xf.borderId)
			}
		}

		if (fixedBorders.has(xf.borderId)) lost = true

		const font = fonts[xf.fontId]

		if (font !== undefined && (font.underline === "singleAccounting" || font.underline === "doubleAccounting")) {
			fonts[xf.fontId] = { ...font, underline: font.underline === "singleAccounting" ? "single" : "double" }
			fixedFonts.add(xf.fontId)
		}

		if (fixedFonts.has(xf.fontId)) lost = true

		const alignment = xf.alignment
		let next: XlsxXf = xf

		if (alignment !== undefined) {
			const horizontal =
				alignment.horizontal === "centerContinuous"
					? "center"
					: alignment.horizontal === "distributed"
						? "justify"
						: alignment.horizontal
			const vertical = alignment.vertical === "justify" || alignment.vertical === "distributed" ? "top" : alignment.vertical

			if (horizontal !== alignment.horizontal || vertical !== alignment.vertical) {
				next = {
					...next,
					alignment: {
						...alignment,
						...(horizontal !== undefined && { horizontal }),
						...(vertical !== undefined && { vertical })
					}
				}
				lost = true
			}
		}

		if (next !== xf) xfs[index] = next
		if (lost) report.note("cellFormat", undefined)
	}
}

function usedStyles(workbook: XlsxWorkbook): Set<number> {
	const used = new Set<number>([0])

	for (const entry of workbook.sheets) {
		const model = entry.model

		if (model === null) continue

		for (const range of model.cols) if (range.style >= 0) used.add(range.style)

		for (const block of model.store.blocks) {
			for (let index = 0; index < block.rowCount; index++)
				if ((block.rowStyles[index] ?? -1) >= 0) used.add(block.rowStyles[index] ?? 0)
			for (let k = 0, end = block.rowStarts[block.rowCount] ?? 0; k < end; k++) used.add(block.styles[k] ?? 0)
		}
	}

	return used
}

// Number formats as data styles hold them (ODF 1.3 Part 3 §16.29): each one the formats use written as a data style
// and read back, in a package of its own; one that does not show as it did (blank-padding "?" placeholders, say)
// takes the form it reads back as, one no data style can say General. Each format so changed is reported once.
async function prepareNumberFormats(
	styles: XlsxStyleTable,
	codeOf: (xf: number) => string,
	palette: readonly number[],
	used: ReadonlySet<number>,
	report: SheetLossyReport
): Promise<void> {
	const xfs = styles.cellXfs as XlsxXf[]
	const codes = new Map<string, number[]>()

	for (const index of used) {
		const source = codeOf(index)

		if (source === "General" || xfs[index] === undefined) continue

		// A section showing no digits pads with "?" as wide as a digit (ECMA-376 Part 1 §18.8.31): as literal spaces,
		// which a data style holds (number:text).
		const code = blankPadding(source)

		if (code !== source) xfs[index] = { ...(xfs[index] as XlsxXf), numFmtId: styles.numFmtId(code) }

		const list = codes.get(code)

		if (list === undefined) codes.set(code, [index])
		else list.push(index)
	}

	if (codes.size === 0) return

	const elements: string[] = []
	const cells: string[] = []
	const order: string[] = []

	for (const code of codes.keys()) {
		const name = `N${order.length}`
		const written = dataStyles(code, name, palette)

		if ("refused" in written) {
			for (const index of codes.get(code) ?? []) xfs[index] = { ...(xfs[index] as XlsxXf), numFmtId: 0 }

			report.note("cellFormat", undefined, codes.get(code)?.length ?? 0)

			continue
		}

		for (const element of written.styles) elements.push(element.markup)

		cells.push(`<table:table-cell table:style-name="c${order.length}" office:value-type="float" office:value="1"/>`)
		elements.push(`<style:style style:name="c${order.length}" style:family="table-cell" style:data-style-name="${name}"/>`)
		order.push(code)
	}

	if (order.length === 0) return

	const probe = await openOds(
		bytesSource(
			await packageOf(
				`<office:automatic-styles>${elements.join("")}</office:automatic-styles><office:body><office:spreadsheet><table:table table:name="P"><table:table-row>${cells.join("")}</table:table-row></table:table></office:spreadsheet></office:body>`,
				""
			)
		)
	)
	const model = probe.ok ? probe.workbook.sheets[0]?.model : undefined

	if (!probe.ok || model === undefined || model === null) return

	const document = new XlsxDocument(probe.workbook, new RenderStyleTable(), { kind: "ods" })

	order.forEach((code, k) => {
		const slot = (model.store as SheetStore).locate(0, k)
		const back = slot < 0 ? "General" : document.styles.numFmtCode((model.store as SheetStore).style(slot))

		// The colour shown, not the code: [Color3] reads back as [Red], and the file has the default palette.
		if (back === code || sameShown(code, back, { palette }, {})) return

		const id = back === "General" ? 0 : styles.numFmtId(back)

		for (const index of codes.get(code) ?? []) xfs[index] = { ...(xfs[index] as XlsxXf), numFmtId: id }

		report.note("cellFormat", undefined, codes.get(code)?.length ?? 0)
	})
}

// "?" placeholders of sections that show no digit (a zero section's "-"??) as quoted spaces.
function blankPadding(code: string): string {
	const sections: string[] = []
	let current = ""
	let quoted = false
	let bracket = false

	for (let k = 0; k < code.length; k++) {
		const c = code[k] ?? ""

		if (!quoted && !bracket && c === "\\") {
			current += c + (code[k + 1] ?? "")
			k++
		} else {
			if (c === '"' && !bracket) quoted = !quoted
			else if (c === "[" && !quoted) bracket = true
			else if (c === "]" && !quoted) bracket = false

			if (c === ";" && !quoted && !bracket) {
				sections.push(current)
				current = ""
			} else current += c
		}
	}

	sections.push(current)

	return sections
		.map(section => {
			const bare = section.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, "")

			return /[0#]/.test(bare) || !bare.includes("?")
				? section
				: section.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*.|\?+/g, token =>
						token.startsWith("?") ? `"${" ".repeat(token.length)}"` : token
					)
		})
		.join(";")
}

// --- Names ---

// The defined names OpenDocument holds: a print area on its table, a filter's with its database range, any other
// as a named range or expression; print titles and the rest Excel defines for itself are reported.
function prepareNames(workbook: XlsxWorkbook, report: SheetLossyReport, titles: Map<number, string>): Set<string> {
	const names = workbook.definedNames
	const sheetName = (sheet: number | null): string =>
		(workbook.sheets.find(entry => entry.id === sheet) ?? workbook.sheets[0])?.name ?? ""
	const kept: XlsxDefinedName[] = []
	const sheets = new Set(workbook.sheets.map(entry => entry.name.toUpperCase()))

	for (const name of names) {
		const upper = name.name.toUpperCase()
		const scope = name.sheet === null ? undefined : sheetName(name.sheet)

		if (upper === "_XLNM._FILTERDATABASE") {
			kept.push(name)

			continue
		}

		if (upper === "_XLNM.PRINT_AREA") {
			if (name.sheet !== null && printRanges(name.formula, sheetName(name.sheet)) !== undefined) kept.push(name)
			else report.note("pageSetup", scope)

			continue
		}

		// A sheet's print titles are its page's (page.ts).
		if (upper === "_XLNM.PRINT_TITLES" && name.sheet !== null) {
			titles.set(name.sheet, name.formula)
			kept.push(name)

			continue
		}

		if (upper.startsWith("_XLNM.")) {
			report.note(upper === "_XLNM.PRINT_TITLES" ? "pageSetup" : "definedName", scope)

			continue
		}

		// A name of another workbook's cells ([1]Sheet!A1, ECMA-376 Part 1 §18.17.2.3) or of a sheet that is not
		// here: OpenDocument would take it for a sheet of this one.
		const area = /^(?:'((?:[^']|'')+)'|([^!'\s]+))!/.exec(name.formula.trim())
		const named = area === null ? undefined : (area[1]?.replaceAll("''", "'") ?? area[2] ?? "")

		if (/\[\d+\]/.test(name.formula) || (named !== undefined && !sheets.has(named.toUpperCase()))) {
			report.note(/\[\d+\]/.test(name.formula) ? "externalLink" : "definedName", scope)

			continue
		}

		try {
			namesPlan([name], [], sheetName)

			// ODF 1.3 has no hidden name (table:named-range, ODF 1.3 Part 3 §9.4.12): written shown.
			if (name.hidden) report.note("definedName", scope)

			kept.push(name.hidden ? { ...name, hidden: false } : name)
		} catch (error) {
			if (!(error instanceof NameRefused)) throw error

			report.note("definedName", scope)
		}
	}

	const keptNames = new Set(kept.map(name => `${name.sheet ?? ""}\u0000${name.name.toUpperCase()}`))
	const dropped = new Set(
		names.filter(name => !keptNames.has(`${name.sheet ?? ""}\u0000${name.name.toUpperCase()}`)).map(name => name.name.toUpperCase())
	)

	spliceAll(names, 0, names.length, kept)

	return dropped
}

// --- Validations and filters ---

// Whether a formula names one of `names` (upper case).
function namesAny(formula: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0) return false

	for (const match of formula.matchAll(/[A-Za-z_\\][\w.]*/g)) if (names.has(match[0].toUpperCase())) return true

	return false
}

// Validations as table:content-validation can say them: those it cannot, and those naming a name not written, are
// left out and reported.
async function prepareValidations(
	workbook: XlsxWorkbook,
	prep: SheetPrep,
	report: SheetLossyReport,
	dropped: ReadonlySet<string>,
	clock: SliceClock | undefined
): Promise<void> {
	const { entry, model } = prep
	const index = model.sections.findIndex(section => section.name === "dataValidations")
	const section = model.sections[index]

	if (section?.bytes === null || section?.bytes === undefined) return

	const markup = decodeUtf8(section.bytes)
	const tries = async (text: string): Promise<boolean> => {
		const sections = model.sections.map((candidate, k) => (k === index ? { ...candidate, bytes: encodeUtf8(text) } : candidate))
		const probe = { ...model, sections } as XlsxSheetModel

		try {
			await runSliced(sheetValidationsSteps(workbook, probe, entry.name, null, null, new Set()), clock)

			return true
		} catch (error) {
			if (error instanceof ValidationRefused) return false

			throw error
		}
	}

	const formulas = (rule: string): string =>
		[...rule.matchAll(/<(?:\w+:)?formula[12]>([\s\S]*?)<\/(?:\w+:)?formula[12]>/g)].map(match => match[1] ?? "").join(" ")
	const open = /^\s*<[^>]*>/.exec(markup)?.[0] ?? ""
	const close = markup.slice(markup.lastIndexOf("</"))
	const rules = [...markup.matchAll(/<(?:\w+:)?dataValidation\b(?:[^>]*\/>|[\s\S]*?<\/(?:\w+:)?dataValidation>)/g)].map(match =>
		// Attribute values as the reader writes them (escapeAttribute), which the rules are compared by.
		match[0].replace(/^<[^>]*>/, tag =>
			tag.replace(
				/(\s[\w:.-]+=)"([^"]*)"/g,
				(_all, name: string, value: string) => `${name}"${escapeAttribute(attributeValue(value))}"`
			)
		)
	)
	// The rules kept: each first tried alone (`one`), or none tried until all are, together, at the end.
	const choose = async (one: boolean): Promise<string[]> => {
		// A cell one rule already holds keeps that rule (a table cell has one validation).
		const held = new RangeIndex()
		const keep: string[] = []

		for (const written of rules) {
			if (clock?.due === true) await clock.pause()

			const listed = (/\ssqref="([^"]*)"/.exec(written)?.[1] ?? "").split(/\s+/).flatMap(text => {
				const range = parseRangeRef(text)

				return range === null || range === undefined ? [] : [{ text, range }]
			})
			// A range another of the rule's holds whole adds no cell (the largest first); one that only overlaps another
			// would name its cells twice.
			const own = new RangeIndex()
			const ranges: typeof listed = []
			let crossed = false

			for (const item of [...listed].sort((a, b) => area(b.range) - area(a.range))) {
				if (own.containing(item.range)) continue
				if (own.overlaps(item.range)) {
					crossed = true

					break
				}

				own.add(item.range)
				ranges.push(item)
			}

			if (crossed) continue
			if (ranges.some(item => held.overlaps(item.range))) continue

			const rule =
				ranges.length === listed.length
					? written
					: written.replace(/\ssqref="[^"]*"/, ` sqref="${ranges.map(item => item.text).join(" ")}"`)

			if (namesAny(formulas(rule), dropped) || (one && !(await tries(`${open}${rule}${close}`)))) continue

			for (const item of ranges) held.add(item.range)
			keep.push(rule)
		}

		return keep
	}
	// One check of every rule together; one by one only where that fails (a rule the writer refuses is left out).
	const optimistic = await choose(false)
	const keep = (await tries(`${open}${optimistic.join("")}${close}`)) ? optimistic : await choose(true)

	report.note("dataValidation", entry.name, rules.length - keep.length)

	const sections = [...model.sections]

	if (keep.length === 0) sections.splice(index, 1)
	else
		sections[index] = {
			...section,
			bytes: encodeUtf8(`${open.replace(/\scount="\d+"/, ` count="${keep.length}"`)}${keep.join("")}${close}`)
		}
	;(model as { sections: readonly XlsxSection[] }).sections = sections
}

function attributeValue(text: string): string {
	const bytes = encodeUtf8(text)

	return decodeCharacterData(bytes, 0, bytes.length, true)
}

// Excel's "hide what is not used" (sheetFormatPr zeroHeight, a default column width of 0; ECMA-376 Part 1
// §18.3.1.81): the rows without a row of their own as hidden runs, the columns without a range as hidden ranges, both
// at Excel's standard size, which OpenDocument (whose defaults hide nothing) holds.
function hideUnused(model: XlsxSheetModel): void {
	const format = model.format

	if (format.zeroHeight || format.defaultRowHeight === 0) {
		const runs: XlsxRowRun[] = []
		let next = 0

		for (const block of model.store.blocks)
			for (let index = 0; index < block.rowCount; index++) {
				const row = block.firstRow + (block.rows[index] ?? 0)

				if (row > next && format.zeroHeight) runs.push({ first: next, last: row - 1, flags: RowFlag.HIDDEN, heightPt: Number.NaN })

				next = row + 1
			}

		if (next < SHEET_MAX_ROWS && format.zeroHeight)
			runs.push({ first: next, last: SHEET_MAX_ROWS - 1, flags: RowFlag.HIDDEN, heightPt: Number.NaN })

		model.rowRuns = runs.length === 0 ? undefined : runs
		model.format = {
			...format,
			zeroHeight: false,
			defaultRowHeight: format.defaultRowHeight > 0 ? format.defaultRowHeight : STANDARD_ROW_PT
		}
	}

	if (model.format.defaultColWidth === 0 || model.format.defaultColPx === 0) {
		const cols: XlsxColRange[] = []
		let next = 0

		for (const range of [...model.cols].sort((a, b) => a.first - b.first)) {
			if (range.first > next) cols.push({ first: next, last: range.first - 1, width: Number.NaN, style: -1, flags: ColFlag.HIDDEN })

			cols.push(range)
			next = Math.max(next, range.last + 1)
		}

		if (next < SHEET_MAX_COLS) cols.push({ first: next, last: SHEET_MAX_COLS - 1, width: Number.NaN, style: -1, flags: ColFlag.HIDDEN })

		model.cols = cols

		const { defaultColPx: _px, ...rest } = model.format

		model.format = { ...rest, defaultColWidth: Number.NaN }
	}
}

// Excel's standard row height (Calibri 11).
const STANDARD_ROW_PT = 15

// Rows of no height as hidden rows of the default height.
function hideEmptyRows(model: XlsxSheetModel): void {
	const rows: RowProperties[] = []

	for (const block of model.store.blocks)
		for (let index = 0; index < block.rowCount; index++)
			if (block.rowHeights[index] === 0)
				rows.push({
					row: block.firstRow + (block.rows[index] ?? 0),
					height: Number.NaN,
					style: block.rowStyles[index] ?? -1,
					flags: ((block.rowFlags[index] ?? 0) | RowFlag.HIDDEN) & ~RowFlag.CUSTOM_HEIGHT
				})

	;(model.store as SheetStore).setRows(rows)
}

// Ranges by the bands of rows they reach, for asking which one a range overlaps without looking at every one.
// Ranges held apart (none overlaps another), asked whether a range overlaps or lies in one: whole columns and whole
// rows as sorted spans (a binary search each), any other range in bands of rows. Linear in what it holds, however
// many whole columns or rows a sheet's rules name.
class Spans {
	private readonly starts: number[] = []
	private readonly ends: number[] = []

	// The index of the last span starting at or before `at`, -1 for none.
	private before(at: number): number {
		let low = 0
		let high = this.starts.length - 1
		let found = -1

		while (low <= high) {
			const middle = (low + high) >> 1

			if ((this.starts[middle] ?? 0) <= at) {
				found = middle
				low = middle + 1
			} else high = middle - 1
		}

		return found
	}

	add(start: number, end: number): void {
		const at = this.before(start) + 1

		this.starts.splice(at, 0, start)
		this.ends.splice(at, 0, end)
	}

	overlaps(start: number, end: number): boolean {
		const at = this.before(end)

		return at >= 0 && (this.ends[at] ?? -1) >= start
	}

	containing(start: number, end: number): boolean {
		const at = this.before(start)

		return at >= 0 && (this.ends[at] ?? -1) >= end
	}
}

class RangeIndex {
	private readonly columns = new Spans()
	private readonly rows = new Spans()
	private readonly bands = new Map<number, SheetRange[]>()
	// The banded ranges' bands, for a whole column asking.
	private readonly bandKeys = new Set<number>()

	add(range: SheetRange): void {
		if (wholeColumns(range)) return this.columns.add(range.startCol, range.endCol)
		if (wholeRows(range)) return this.rows.add(range.startRow, range.endRow)

		for (let band = range.startRow >> BAND_SHIFT; band <= range.endRow >> BAND_SHIFT; band++) {
			const list = this.bands.get(band)

			this.bandKeys.add(band)

			if (list === undefined) this.bands.set(band, [range])
			else list.push(range)
		}
	}

	overlaps(range: SheetRange): boolean {
		if (this.columns.overlaps(range.startCol, range.endCol) || this.rows.overlaps(range.startRow, range.endRow)) return true

		// The bands holding ranges, or the range's own, whichever are fewer.
		const first = range.startRow >> BAND_SHIFT
		const last = range.endRow >> BAND_SHIFT

		if (last - first + 1 > this.bandKeys.size) {
			for (const band of this.bandKeys)
				if (band >= first && band <= last && this.bands.get(band)?.some(other => overlaps(range, other)) === true) return true

			return false
		}

		for (let band = first; band <= last; band++) if (this.bands.get(band)?.some(other => overlaps(range, other)) === true) return true

		return false
	}

	containing(range: SheetRange): boolean {
		return (
			this.columns.containing(range.startCol, range.endCol) ||
			this.rows.containing(range.startRow, range.endRow) ||
			this.bands.get(range.startRow >> BAND_SHIFT)?.some(other => contains(other, range)) === true
		)
	}
}

function wholeColumns(range: SheetRange): boolean {
	return range.startRow === 0 && range.endRow === SHEET_MAX_ROWS - 1
}

function wholeRows(range: SheetRange): boolean {
	return range.startCol === 0 && range.endCol === SHEET_MAX_COLS - 1
}

function area(range: SheetRange): number {
	return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
}

const BAND_SHIFT = 10

function contains(outer: SheetRange, inner: SheetRange): boolean {
	return (
		outer.startRow <= inner.startRow && outer.endRow >= inner.endRow && outer.startCol <= inner.startCol && outer.endCol >= inner.endCol
	)
}

function overlaps(a: SheetRange, b: SheetRange): boolean {
	return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startCol <= b.endCol && b.startCol <= a.endCol
}

function prepareFilter(prep: SheetPrep, report: SheetLossyReport): void {
	const { entry, model } = prep
	const index = model.sections.findIndex(section => section.name === "autoFilter")
	const section = model.sections[index]

	if (section?.bytes === null || section?.bytes === undefined) return

	const markup = decodeUtf8(section.bytes)
	const tries = (text: string): boolean => {
		try {
			filterRange(text, entry.name, "check")

			return true
		} catch (error) {
			if (error instanceof FilterRefused) return false

			throw error
		}
	}

	if (tries(markup)) return

	report.note("filter", entry.name)

	// The range alone: its buttons stay, its criteria go.
	const open = /^\s*<[^>]*?(\/?)>/.exec(markup)
	const bare = open === null ? "" : `${open[0].replace(/\/?>$/, "")}/>`
	const sections = [...model.sections]

	if (bare !== "" && tries(bare)) sections[index] = { ...section, bytes: encodeUtf8(bare) }
	else sections.splice(index, 1)
	;(model as { sections: readonly XlsxSection[] }).sections = sections
}

interface SheetTablePart {
	readonly table: SheetTable
	// Its autoFilter (ECMA-376 Part 1 §18.3.1.2), namespaces declared, or null.
	readonly filter: string | null
	// It names a table style (§18.5.1.5), whose look has no home here.
	readonly styled: boolean
}

function rangeAddress(sheet: string, range: SheetRange): string {
	const quoted = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`

	return `${quoted}.${cellRef(range.startRow, range.startCol)}:${quoted}.${cellRef(range.endRow, range.endCol)}`
}

// A sheet's tables (§18.5.1.2) as database ranges (ODF 1.3 Part 3 §9.4.15) of their names, cells and header row, a
// totals row as LibreOffice's calcext:contains-footer. A sheet's filter buttons are one range's: the first filtered
// table's becomes the sheet's own filter where the sheet has none; others' are reported, as are table styles.
function prepareTables(prep: SheetPrep, parts: readonly SheetTablePart[], report: SheetLossyReport): string[] {
	const { entry, model } = prep
	const ranges: string[] = []
	let filtered = model.sections.some(section => section.name === "autoFilter")

	for (const { table, filter, styled } of parts) {
		if (styled) report.note("table", entry.name)

		if (filter !== null && !filtered) {
			filtered = true

			const tries = (text: string): boolean => {
				try {
					filterRange(text, entry.name, "check")

					return true
				} catch (error) {
					if (error instanceof FilterRefused) return false

					throw error
				}
			}
			const open = /^\s*<[^>]*?(\/?)>/.exec(filter)
			const bare = open === null ? "" : `${open[0].replace(/\/?>$/, "")}/>`
			const held = tries(filter) ? filter : bare !== "" && tries(bare) ? bare : null

			if (held !== filter) report.note("filter", entry.name)
			if (table.totalsRows > 0) report.note("table", entry.name)

			if (held !== null) {
				;(model as { sections: readonly XlsxSection[] }).sections = [
					...model.sections,
					{ name: "autoFilter", start: 0, end: 0, bytes: encodeUtf8(held) }
				]

				continue
			}
		} else if (filter !== null) {
			report.note("filter", entry.name)
		}

		ranges.push(
			`<table:database-range${attr("table:name", table.name)}${attr("table:target-range-address", rangeAddress(entry.name, table.ref))}${attr("table:contains-header", String(table.headerRows > 0))}${table.totalsRows > 0 ? ' calcext:contains-footer="true"' : ""}/>`
		)
	}

	return ranges
}

// --- Workbook parts ---

async function reportParts(workbook: XlsxWorkbook, report: SheetLossyReport): Promise<void> {
	let pivots = 0
	let threads = 0
	let externals = 0
	let metadata = false

	for (const part of workbook.parts.parts()) {
		const type = part.contentType.toLowerCase()

		if (type.includes("vbaproject")) report.note("macros", undefined)
		else if (type.endsWith("pivottable+xml")) pivots++
		else if (type.endsWith("externallink+xml") || type.endsWith("connections+xml") || type.endsWith("querytable+xml")) externals++
		else if (type.endsWith("threadedcomments+xml"))
			threads += count(decodeUtf8(await workbook.parts.read(part.name)), /<(?:\w+:)?threadedComment\b/g)
		else if (type.endsWith("slicer+xml") || type.endsWith("timeline+xml")) report.note("filter", undefined)
		else if (type === "application/vnd.openxmlformats-package.core-properties+xml") {
			const text = decodeUtf8(await workbook.parts.read(part.name))

			metadata ||= /<(?:\w+:)?(?:title|subject|creator|keywords|description|category)\b[^>]*>\s*[^<\s]/.test(text)
		} else if (type.endsWith("custom-properties+xml")) metadata = true
		else if (/^\/?customxml\//i.test(part.name)) metadata = true
	}

	report.note("pivotTable", undefined, pivots)
	report.note("threadedComment", undefined, threads)
	report.note("externalLink", undefined, externals)

	if (metadata) report.note("metadata", undefined)
}

// --- The package written into ---

const NAMESPACES =
	`xmlns:office="${OdfNs.office}" xmlns:style="${OdfNs.style}" xmlns:text="${OdfNs.text}" xmlns:table="${OdfNs.table}"` +
	` xmlns:fo="${OdfNs.fo}" xmlns:svg="${OdfNs.svg}" xmlns:number="${OdfNs.number}" xmlns:xlink="${OdfNs.xlink}"` +
	` xmlns:dc="${OdfNs.dc}" xmlns:of="${OdfNs.of}" xmlns:draw="${OdfNs.draw}" xmlns:calcext="${OdfNs.calcext}" xmlns:loext="${OdfNs.loext}"`

// A spreadsheet package of content.xml's and styles.xml's children as given, with the namespaces the writer uses
// declared (ODF 1.3 Part 2 §3), LibreOffice's own among them: the file is of extended conformance (Part 1 §2.2.2), its
// cached error results calcext:value-type="error" (which LibreOffice keeps rather than calculating again) and what a
// protected sheet allows loext:table-protection.
async function packageOf(content: string, styles: string, files: PackageFiles = new PackageFiles()): Promise<Uint8Array> {
	const entry = (path: string, mediaType: string, version = false): string =>
		`<manifest:file-entry manifest:full-path="${escapeAttribute(path)}"${version ? ' manifest:version="1.3"' : ""} manifest:media-type="${escapeAttribute(mediaType)}"/>`
	const manifest =
		'<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
		entry("/", MEDIA_TYPE, true) +
		entry("content.xml", "text/xml") +
		entry("styles.xml", "text/xml") +
		files.files
			.map(
				file =>
					(file.directory === undefined ? "" : entry(file.directory, CHART_MEDIA_TYPE, true)) + entry(file.path, file.mediaType)
			)
			.join("") +
		"</manifest:manifest>"
	const sink = memorySink()
	const parts: [string, string | Uint8Array, boolean][] = [
		["mimetype", MEDIA_TYPE, false],
		[
			"content.xml",
			`<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NAMESPACES} office:version="1.3">${content}</office:document-content>`,
			true
		],
		[
			"styles.xml",
			`<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NAMESPACES} office:version="1.3">${styles}</office:document-styles>`,
			true
		],
		...files.files.map((file): [string, string | Uint8Array, boolean] => [file.path, file.bytes, typeof file.bytes === "string"]),
		["META-INF/manifest.xml", manifest, true]
	]

	await writeZip(
		{
			items: parts.map(([name, text, compress]) => ({
				kind: "data" as const,
				name,
				bytes: BytePieces.of([typeof text === "string" ? encodeUtf8(text) : text]),
				compress
			}))
		},
		null,
		sink
	)

	return sink.bytes()
}

// How the workbook calculates, which the writer copies (ODF 1.3 Part 3 §9.4.1): its null date (the 1904 date system's
// day 0, §9.4.2) and its iteration (§9.4.3).
function calculation(workbook: XlsxWorkbook): string {
	const calc = workbook.calc
	const date = workbook.date1904 ? '<table:null-date table:date-value="1904-01-01"/>' : ""
	const iteration = calc.iterate
		? `<table:iteration table:status="enable"${attr("table:steps", String(calc.iterateCount))}${attr("table:maximum-difference", String(calc.iterateDelta))}/>`
		: ""

	return date === "" && iteration === "" ? "" : `<table:calculation-settings>${date}${iteration}</table:calculation-settings>`
}

// An empty spreadsheet of one table the save leaves out (every sheet is new), its default cell style the look of
// the workbook's format 0 (which every cell without a format of its own shows), in the user's language (fo:language, fo:country).
function emptyPackage(
	styles: SheetStyles,
	workbook: XlsxWorkbook,
	language: string,
	common: string,
	pages: PageStyles,
	databaseRanges: readonly string[],
	files: PackageFiles
): Promise<Uint8Array> {
	const family = styles.renderStyle(0).font ?? "Calibri"
	const faces = `<office:font-face-decls><style:font-face${attr("style:name", family)}${attr("svg:font-family", family)}/></office:font-face-decls>`
	// A cell style writes its paragraph properties only where it has them: the default has none to pass on.
	const { language: tongue, script, region } = tagParts(templateLocale(language).tag)
	const defaults = cellStyleProperties(styles, 0, name => name)
		.replace(/<style:paragraph-properties\b[^>]*\/>/, "<style:paragraph-properties/>")
		.replace(
			"<style:text-properties",
			`<style:text-properties${attr("fo:language", tongue)}${script === undefined ? "" : attr("fo:script", script)}${region === undefined ? "" : attr("fo:country", region)}`
		)

	return packageOf(
		`${faces}<office:automatic-styles/><office:body><office:spreadsheet>${calculation(workbook)}<table:table table:name="Sheet1"><table:table-column/><table:table-row><table:table-cell/></table:table-row></table:table>${databaseRanges.length === 0 ? "" : `<table:database-ranges>${databaseRanges.join("")}</table:database-ranges>`}</office:spreadsheet></office:body>`,
		`${faces}<office:styles><style:default-style style:family="table-cell">${defaults}</style:default-style>${common}</office:styles>` +
			`<office:automatic-styles>${pages.automatic}</office:automatic-styles><office:master-styles>${pages.master}</office:master-styles>`,
		files
	)
}

const NO_PAGE: SheetPageMarkup = {
	pageSetup: "",
	pageMargins: "",
	printOptions: "",
	headerFooter: "",
	rowBreaks: "",
	colBreaks: "",
	sheetPr: ""
}

function colFlags(cols: readonly XlsxColRange[], col: number): number {
	return cols.find(range => col >= range.first && col <= range.last)?.flags ?? 0
}

// Whether every row (column) of a span is at one outline level.
function sameLevel(
	span: TitleSpan,
	flags: (at: number) => number,
	bits: { readonly OUTLINE_MASK: number; readonly OUTLINE_SHIFT: number }
): boolean {
	const level = (at: number): number => (flags(at) & bits.OUTLINE_MASK) >> bits.OUTLINE_SHIFT
	const first = level(span.first)

	for (let at = span.first + 1; at <= span.last; at++) if (level(at) !== first) return false

	return true
}

function openFailure(reason: string, message: string): SheetConversion {
	switch (reason) {
		case "aborted":
			return { ok: false, reason: "aborted", message }
		case "encrypted":
			return { ok: false, reason: "encrypted", message }
		case "tooLarge":
			return { ok: false, reason: "tooLarge", message }
		case "malformed":
		case "failed":
			return { ok: false, reason: "corrupt", message }
		default:
			return { ok: false, reason: "notSource", message }
	}
}

export async function xlsxToOds(source: Uint8Array, options: SheetConvertOptions = {}): Promise<SheetConversion> {
	const turns = options.turns
	const clock = abortClock(options)
	const opened = await openXlsx(bytesSource(source), {
		...(clock !== undefined && { slicing: clock }),
		...(turns !== undefined && { signal: turns.signal })
	})

	if (!opened.ok) return openFailure(opened.reason, opened.message)

	const workbook = opened.workbook
	const report = new SheetLossyReport(workbook.sheets.map(entry => entry.name))
	const sheets: SheetPrep[] = []

	const drawings = new Map<number, string>()

	for (const [index, entry] of workbook.sheets.entries()) {
		// A chart sheet: a sheet holding its chart, at its top left.
		if (entry.kind === "chartsheet") {
			const drawing = (await partRelationships(workbook, entry.part)).find(
				relationship => !relationship.external && relationshipKind(relationship.type) === "drawing"
			)?.partName
			const model = new XlsxSheet({
				id: entry.id,
				part: entry.part,
				store: new SheetStore([], new SheetStrings(), new FormulaTable()),
				sections: [],
				relationships: new Relationships([]),
				rootStart: 0,
				rootOpenEnd: 0,
				rootEnd: 0,
				prefix: "",
				utf16: false
			})
			const sheet: XlsxSheetEntry = { ...entry, kind: "worksheet", model }

			;(workbook.sheets as XlsxSheetEntry[])[index] = sheet
			sheets.push({ entry: sheet, model })

			if (drawing === undefined || workbook.parts.get(drawing) === undefined) report.note("chart", entry.name)
			else drawings.set(entry.id, drawing)

			continue
		}

		// A dialog or macro sheet has no home here.
		if (entry.kind !== "worksheet") {
			report.note("other", entry.name)

			continue
		}

		try {
			const model = await workbook.load(entry.id, clock, turns?.signal)

			sheets.push({ entry, model })
		} catch (error) {
			if (error instanceof XlsxReadError)
				return openFailure(error.code === "tooLarge" || error.code === "aborted" ? error.code : "malformed", error.message)

			throw error
		}
	}

	if (sheets.length === 0) return { ok: false, reason: "unsupported", message: "The workbook has no worksheet" }
	if (workbook.macros) report.note("macros", undefined)

	const comments = new Map<string, Uint8Array>()
	const memo = new Map<number, boolean>()
	const codes = new Map<string, boolean>()
	const richStrings = new Map<number, number>()
	const probe = new XlsxDocument(workbook, new RenderStyleTable(), { kind: "xlsx" })
	const dateCells = (xf: number): boolean => {
		let shows = memo.get(xf)

		if (shows === undefined) memo.set(xf, (shows = showsDate(probe.styles.numFmtCode(xf), codes)))

		return shows
	}

	const titles = new Map<number, string>()
	const dropped = prepareNames(workbook, report, titles)
	const tables = new Map<string, SheetTable>()
	const conditions = new Map<number, string[]>()
	const pageMarkup = new Map<number, SheetPageMarkup>()
	const sheetTables = new Map<number, SheetTablePart[]>()
	const databaseRanges: string[] = []

	for (const prep of sheets)
		await prepareSections(workbook, prep, report, comments, tables, conditions, pageMarkup, sheetTables, drawings)

	for (const prep of sheets) {
		await prepareCells(workbook, prep, report, clock, dateCells, color => probe.styles.color(color), richStrings, dropped, tables)
		await prepareValidations(workbook, prep, report, dropped, clock)
		prepareFilter(prep, report)
		appendAll(databaseRanges, prepareTables(prep, sheetTables.get(prep.entry.id) ?? [], report))

		// Panes split one way only scroll together the other way: OpenDocument keeps one position for both.
		const view = prep.model.view
		const frozen = view.frozen

		if (frozen !== null && (frozen.cols === 0 || frozen.rows === 0))
			prep.model.view = {
				...view,
				frozen: {
					...frozen,
					topLeftCol: frozen.cols === 0 ? view.leftCol : frozen.topLeftCol,
					topLeftRow: frozen.rows === 0 ? view.topRow : frozen.topLeftRow
				}
			}

		// A password's salted, spun hash is not one OpenDocument holds (it keeps a plain digest), nor what a protected
		// sheet allows beyond LibreOffice's attributes (loext:table-protection).
		const protection = prep.model.protection

		if (protection !== null) {
			// What it allows as loext:table-protection holds it; the rest (objects, scenarios, formats…) has no home.
			const allows = new Set([...protection.allows].filter(action => PROTECTION_ALLOWS.has(action)))

			if (Object.keys(protection.hash).length > 0) report.note("protectionPassword", prep.entry.name)
			if (allows.size !== protection.allows.size) report.note("other", prep.entry.name)

			prep.model.protection = { hash: {}, allows }
		}

		// A column or row of no width or height is hidden (ECMA-376 Part 1 §18.3.1.13, §18.3.1.73): ODF lengths are
		// positive, so it is written hidden at the default size.
		prep.model.cols = prep.model.cols.map(range =>
			range.width === 0 || range.px === 0
				? { ...range, width: Number.NaN, ...(range.px !== undefined && { px: Number.NaN }), flags: range.flags | ColFlag.HIDDEN }
				: range
		)
		hideEmptyRows(prep.model)
		hideUnused(prep.model)
	}

	const used = usedStyles(workbook)

	if (clock?.due === true) await clock.pause()
	prepareStyles(workbook.styles, used, report)
	await prepareNumberFormats(workbook.styles, xf => probe.styles.numFmtCode(xf), probe.styles.palette, used, report)
	if (clock?.due === true) await clock.pause()
	await reportParts(workbook, report)

	// The sheet the file opens on is a visible worksheet: a chart or dialog sheet is not written, and OpenDocument has
	// no very hidden sheet.
	const active = workbook.sheets[workbook.activeTab]

	if (active?.kind !== "worksheet" || active.state !== "visible") {
		const first = workbook.sheets.findIndex(entry => entry.kind === "worksheet" && entry.state === "visible")

		;(workbook as { activeTab: number }).activeTab = Math.max(0, first)
	}

	const book = workbook as { protection: XlsxWorkbook["protection"] }

	if (book.protection !== null) {
		if (Object.keys(book.protection.hash).length > 0) report.note("protectionPassword", undefined)
		if (book.protection.windows) report.note("other", undefined)

		book.protection = book.protection.structure ? { structure: true, windows: false, hash: {} } : null
	}

	// Every sheet a new table of an empty package (its one table left out).
	// Conditional formats as calcext:conditional-formats, their looks common styles of the package.
	// Each sheet's page as a master page.
	const conditionStyles = new ConditionStyles(workbook.styles, probe.styles)
	const pageStyles = new PageStyles()
	const newTables = new Map<number, NewTable>()
	const files = new PackageFiles()
	const shapeStyles = new ShapeStyles()
	const theme = drawings.size === 0 ? null : await workbookDrawingTheme(workbook)

	for (const prep of sheets) {
		const { entry, model } = prep
		const written = sheetConditions(conditions.get(entry.id) ?? [], entry.name, conditionStyles)
		const page = pageStyles.sheet(pageMarkup.get(entry.id) ?? NO_PAGE, titles.get(entry.id) ?? null)
		const view = new SheetView(probe, model)
		// Print titles are rows (columns) of one outline level, as table:table-header-rows hold no group.
		const titleRows =
			page.titleRows !== null && sameLevel(page.titleRows, row => view.rowProps(row).flags, RowFlag) ? page.titleRows : null
		const titleCols =
			page.titleCols !== null && sameLevel(page.titleCols, col => colFlags(model.cols, col), ColFlag) ? page.titleCols : null

		report.note("conditionalFormat", entry.name, written.lost)

		const titlesLost =
			titles.has(entry.id) &&
			(titleRows !== page.titleRows || titleCols !== page.titleCols || (titleRows === null && titleCols === null))

		if (page.lost || titlesLost) report.note("pageSetup", entry.name)

		// Titles not held are no name either; those held, the name as the header rows and columns read back: rows
		// first.
		const names = workbook.definedNames
		const at = names.findIndex(name => name.sheet === entry.id && name.name.toUpperCase() === "_XLNM.PRINT_TITLES")
		const held = names[at]

		if (held !== undefined && titlesLost) names.splice(at, 1)
		else if (held !== undefined)
			names[at] = {
				...held,
				formula: [
					...(titleRows === null
						? []
						: [`${sheetRef(entry.name)}$${String(titleRows.first + 1)}:$${String(titleRows.last + 1)}`]),
					...(titleCols === null ? [] : [`${sheetRef(entry.name)}$${columnName(titleCols.first)}:$${columnName(titleCols.last)}`])
				].join(",")
			}

		const drawing = drawings.get(entry.id)
		const placed =
			drawing === undefined || theme === null
				? null
				: await sheetFrames(workbook, drawing, entry.name, model, view, files, theme, shapeStyles, clock).catch(
						(error: unknown) => {
							if (error instanceof DrawingRefused) return error

							throw error
						}
					)

		if (placed instanceof DrawingRefused) return { ok: false, reason: "tooLarge", message: placed.message }

		if (placed !== null) {
			report.note("picture", entry.name, placed.lostPictures)
			report.note("chart", entry.name, placed.lostCharts)
		}

		newTables.set(entry.id, {
			...(placed !== null && placed.frames.size > 0 && { frames: placed.frames }),
			masterPage: page.masterPage,
			rowBreaks: page.rowBreaks,
			colBreaks: page.colBreaks,
			titleRows,
			titleCols,
			end: written.markup
		})
	}

	if (clock?.due === true) await clock.pause()
	const empty = await openOds(
		bytesSource(
			await emptyPackage(
				probe.styles,
				workbook,
				options.language ?? "en-US",
				conditionStyles.markup + shapeStyles.styles,
				pageStyles,
				databaseRanges,
				files
			)
		)
	)

	if (!empty.ok) return { ok: false, reason: "unsupported", message: `The empty package does not open: ${empty.message}` }

	const base = odsSource(empty.workbook) as OdsSource

	setOdsSource(workbook, { ...base, parts: comments })

	if (clock?.due === true) await clock.pause()
	const document = new XlsxDocument(workbook, new RenderStyleTable(), { kind: "xlsx" })
	const saved = await saveOds(document, {
		...(turns !== undefined && { slicing: turns.slicing, signal: turns.signal }),
		...(options.inflate !== undefined && { inflate: options.inflate }),
		newTables
	})

	if (aborted(options)) return { ok: false, reason: "aborted", message: "The conversion was aborted" }
	if (!saved.ok) return { ok: false, reason: saved.reason === "verify" ? "verify" : "unsupported", message: saved.message }

	return { ok: true, bytes: saved.bytes, lossy: report.list() }
}
