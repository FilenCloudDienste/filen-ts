import type { Relationships } from "../../opc/relationships"
import { SHEET_MAX_COLS, type SheetId, type SheetProtectedAction, type SheetRange } from "../../sheet/protocol"
import type { SliceClock } from "../../slicing"
import { parseXml, parseXmlSliced, transcodeUtf16, XmlError, type XmlDocument } from "../../xml/index"
import { FormulaTable } from "../model/formulas"
import { SheetStore, orphanedSharedSteps, type RowBlock } from "../model/store"
import { SheetStrings } from "../model/strings"
import {
	ColFlag,
	type XlsxColor,
	type XlsxColRange,
	type XlsxProtectionHash,
	type XlsxSection,
	type XlsxSheetFormat,
	type XlsxSheetModel,
	type XlsxSheetProtection,
	type XlsxSheetView
} from "../model/types"
import { XlsxReadError } from "./errors"
import type { XlsxLimits, XlsxReadBudget, XlsxReadLease } from "./limits"
import { AMP, BANG, GT, LT, QUESTION, SLASH, Scanner, bytesAre, localIs, localStart, nameEnd, sameBytes } from "./scan"
import { SheetDataReader, parseRange, rangeAt } from "./sheetData"
import { booleanAttribute, childByLocal, childElements, intAttribute, numberAttribute, readColor } from "./styleRecords"

export class XlsxSheet implements XlsxSheetModel {
	readonly id: SheetId
	readonly part: string
	readonly store: SheetStore
	readonly sections: readonly XlsxSection[]
	readonly relationships: Relationships
	sourceOrphanedShared: ReadonlySet<number> = new Set()
	cols: readonly XlsxColRange[]
	merges: Uint32Array
	format: XlsxSheetFormat
	view: XlsxSheetView
	protection: XlsxSheetProtection | null
	tabColor: XlsxColor | null
	// The root element: where its start tag begins and ends, and where its end tag ends.
	readonly rootStart: number
	readonly rootOpenEnd: number
	readonly rootEnd: number
	// The prefix the root's SpreadsheetML elements carry ("" for the default namespace).
	readonly prefix: string
	// The part was UTF-16: spans index its UTF-8 transcoding, so the part is rewritten whole, never spliced.
	readonly utf16: boolean
	readonly freshRoot: string | undefined

	constructor(init: {
		id: SheetId
		part: string
		store: SheetStore
		sections: readonly XlsxSection[]
		relationships: Relationships
		rootStart: number
		rootOpenEnd: number
		rootEnd: number
		prefix: string
		utf16: boolean
		freshRoot?: string
	}) {
		this.id = init.id
		this.part = init.part
		this.store = init.store
		this.sections = init.sections
		this.relationships = init.relationships
		this.rootStart = init.rootStart
		this.rootOpenEnd = init.rootOpenEnd
		this.rootEnd = init.rootEnd
		this.prefix = init.prefix
		this.utf16 = init.utf16
		this.freshRoot = init.freshRoot
		this.cols = []
		this.merges = new Uint32Array(0)
		this.format = DEFAULT_FORMAT
		this.view = DEFAULT_VIEW
		this.protection = null
		this.tabColor = null
	}

	section(name: string): XlsxSection | undefined {
		return this.sections.find(section => section.name === name)
	}
}

export const DEFAULT_FORMAT: XlsxSheetFormat = {
	defaultRowHeight: 15,
	defaultColWidth: Number.NaN,
	baseColWidth: 8,
	customHeight: false,
	zeroHeight: false,
	thickTop: false,
	thickBottom: false,
	outlineLevelRow: 0,
	outlineLevelCol: 0
}

export const DEFAULT_VIEW: XlsxSheetView = {
	frozen: null,
	topRow: 0,
	leftCol: 0,
	activeRow: 0,
	activeCol: 0,
	selection: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
	zoom: 100,
	gridLines: true,
	headings: true,
	rightToLeft: false,
	tabSelected: false,
	view: "normal"
}

export interface WorksheetReadOptions {
	readonly id: SheetId
	readonly part: string
	readonly relationships: Relationships
	readonly limits: XlsxLimits
	readonly sharedStrings: number
	readonly cellBudget: number
	// The workbook's budget, shared by its sheets: what this sheet reads is taken from it, and given back if the
	// reading fails.
	readonly budget?: XlsxReadBudget
	readonly clock: SliceClock | undefined
	readonly signal: { readonly aborted: boolean } | undefined
}

// Section bytes above which a section parses in slices.
const SLICED_SECTION = 64 * 1024
// Rows (or other children) and cells read between two looks at the clock.
const ROWS_PER_STEP = 256
const CELLS_PER_STEP = 8192
// Sections, and tags inside one, read between two looks at the clock.
const SECTIONS_PER_STEP = 256
const TAGS_PER_STEP = 16_384
// Elements a section the model parses into a tree may hold (sheetPr, sheetFormatPr, sheetViews, sheetProtection
// hold a few each); cols and mergeCells are counted against their own caps.
const MAX_TREE_ELEMENTS = 65_536
const TREE_SECTIONS: ReadonlySet<string> = new Set(["sheetPr", "sheetFormatPr", "sheetViews", "sheetProtection"])

// Parses a worksheet (or chartsheet, dialogsheet, macrosheet) part: every child of the root as a section, the
// cells of sheetData into the store, and the sections the model interprets.
export async function readWorksheet(input: Uint8Array, options: WorksheetReadOptions): Promise<XlsxSheet> {
	const lease = options.budget?.lease(options.part)

	try {
		return await readSheet(input, options, lease)
	} catch (error) {
		lease?.release()

		throw error
	}
}

async function readSheet(input: Uint8Array, options: WorksheetReadOptions, lease: XlsxReadLease | undefined): Promise<XlsxSheet> {
	const { part, limits } = options
	const utf16 = isUtf16(input)
	const bytes = utf16 ? transcodeUtf16(input, input[0] === 0xff || input[0] === 0xfe ? 2 : 0, input[0] === 0xff || input[1] === 0) : input
	const scanner = new Scanner(bytes, part)
	const rootStart = scanner.rootStart(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0)
	const rootName = nameEnd(bytes, rootStart + 1)
	const rootOpenEnd = scanner.tagEnd(rootStart)
	const prefixEnd = localStart(bytes, rootStart + 1, rootName)
	const prefix = prefixEnd > rootStart + 1 ? decodeAscii(bytes, rootStart + 1, prefixEnd - 1) : ""
	const sections: XlsxSection[] = []
	let reader: SheetDataReader | null = null
	let rootEnd = rootOpenEnd
	let at = rootOpenEnd
	let colElements = 0
	let mergeElements = 0
	// Counted, and checked against the caps, before the section is copied.
	const admit = (): void => {
		if (sections.length >= limits.maxSections) throw new XlsxReadError("tooLarge", "The sheet holds more sections than the limit", part)

		lease?.take("sections", 1)
	}

	if (!scanner.selfClosing) {
		for (let read = 0; ; read++) {
			if (read % SECTIONS_PER_STEP === SECTIONS_PER_STEP - 1) {
				if (options.signal?.aborted === true) throw new XlsxReadError("aborted", "Reading was aborted", part)
				if (options.clock?.due === true) await options.clock.pause()
			}

			const lt = bytes.indexOf(LT, at)

			if (lt < 0) scanner.fail("The root element is not closed", rootStart)

			const next = bytes[lt + 1]

			if (next === SLASH) {
				const end = nameEnd(bytes, lt + 2)

				if (end - (lt + 2) !== rootName - (rootStart + 1) || !sameBytes(bytes, lt + 2, rootStart + 1, rootName - rootStart - 1)) {
					scanner.fail("The root's end tag does not match it", lt)
				}

				const close = bytes.indexOf(GT, end)

				if (close < 0) scanner.fail("The root's end tag is not closed", lt)

				rootEnd = close + 1

				break
			}

			if (next === BANG || next === QUESTION) {
				at = scanner.markupEnd(lt)

				continue
			}

			const name = nameEnd(bytes, lt + 1)
			const local = localStart(bytes, lt + 1, name)
			const qualified = decodeAscii(bytes, lt + 1, name)
			const ownPrefix = local > lt + 1 ? qualified.slice(0, local - lt - 2) : ""
			const sectionName = ownPrefix === prefix ? qualified.slice(local - lt - 1) : qualified

			if (sectionName === "sheetData" && reader === null) {
				admit()

				const tagEnd = scanner.tagEnd(lt)

				reader = new SheetDataReader(scanner, tagEnd, {
					part,
					sharedStrings: options.sharedStrings,
					cellBudget: options.cellBudget,
					...(lease !== undefined && { lease })
				})

				let end = tagEnd

				if (!scanner.selfClosing) {
					while (!reader.step(ROWS_PER_STEP, CELLS_PER_STEP)) {
						if (options.signal?.aborted === true) throw new XlsxReadError("aborted", "Reading was aborted", part)
						if (options.clock?.due === true) await options.clock.pause()
					}

					end = reader.end
				}

				sections.push({ name: "sheetData", start: lt, end, bytes: null })
				at = end
			} else {
				admit()

				// The section's elements below its own (what its tree would hold), refused past their cap as soon as
				// they pass it: one range per column at most, the merges the sheet may hold, a few in the others the
				// model parses.
				const cap =
					sectionName === "cols"
						? SHEET_MAX_COLS - colElements
						: sectionName === "mergeCells"
							? limits.maxMerges - mergeElements
							: TREE_SECTIONS.has(sectionName)
								? MAX_TREE_ELEMENTS
								: Number.POSITIVE_INFINITY
				let end = -1

				scanner.elements = 0
				scanner.beginElement(lt)

				for (;;) {
					end = scanner.walk(TAGS_PER_STEP)

					if (scanner.elements - 1 > cap) {
						const what =
							sectionName === "cols"
								? "column ranges"
								: sectionName === "mergeCells"
									? "merged ranges"
									: `${sectionName} elements`

						throw new XlsxReadError("tooLarge", `Too many ${what}`, part)
					}

					if (end >= 0) break
					if (options.signal?.aborted === true) throw new XlsxReadError("aborted", "Reading was aborted", part)
					if (options.clock?.due === true) await options.clock.pause()
				}

				const inner = scanner.elements - 1

				if (sectionName === "cols") {
					colElements += inner
					lease?.take("colRanges", inner)
				} else if (sectionName === "mergeCells") {
					mergeElements += inner
					lease?.take("merges", inner)
				}

				sections.push({ name: sectionName, start: lt, end, bytes: bytes.slice(lt, end) })
				at = end
			}
		}
	}

	let blocks: RowBlock[] = []

	// Rows out of order are sorted and merged in steps, on the same clock.
	if (reader !== null) {
		const steps = reader.builder.finishSteps()
		let step = steps.next()

		while (step.done !== true) {
			if (options.signal?.aborted === true) throw new XlsxReadError("aborted", "Reading was aborted", part)
			if (options.clock?.due === true) await options.clock.pause()

			step = steps.next()
		}

		blocks = step.value
	}

	const store = new SheetStore(
		blocks,
		reader?.strings ?? new SheetStrings(),
		reader?.formulas ?? new FormulaTable(),
		reader?.builder.marked
	)

	reader?.formulas.compact()

	const sheet = new XlsxSheet({
		id: options.id,
		part,
		store,
		sections,
		relationships: options.relationships,
		rootStart,
		rootOpenEnd,
		rootEnd,
		prefix,
		utf16
	})

	await interpretSections(sheet, options.clock)

	// Shared formula children the file itself leaves without a master (kept as written; the gate accepts them).
	const orphaned = orphanedSharedSteps(store)

	for (let step = orphaned.next(); ; step = orphaned.next()) {
		if (step.done === true) {
			sheet.sourceOrphanedShared = step.value

			break
		}

		if (options.signal?.aborted === true) throw new XlsxReadError("aborted", "Reading was aborted", part)
		if (options.clock?.due === true) await options.clock.pause()
	}

	return sheet
}

function isUtf16(bytes: Uint8Array): boolean {
	const b0 = bytes[0]
	const b1 = bytes[1]

	return (b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff) || (b0 === 0x3c && b1 === 0) || (b0 === 0 && b1 === 0x3c)
}

function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
	let out = ""

	for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] ?? 0)

	return out
}

// A section's bytes as a document of their own (a fragment: prefixes bound on the root stay unbound, which the
// tree parser does not need).
async function sectionDocument(sheet: XlsxSheet, section: XlsxSection, clock: SliceClock | undefined): Promise<XmlDocument> {
	const bytes = section.bytes ?? new Uint8Array(0)

	try {
		// A large section (a sheet's merges) parses in slices on a host that slices.
		return clock !== undefined && bytes.length > SLICED_SECTION ? await parseXmlSliced(bytes, clock) : parseXml(bytes)
	} catch (error) {
		if (error instanceof XmlError) throw new XlsxReadError("malformed", error.message, sheet.part, section.start)

		throw error
	}
}

// The counts of cols and mergeCells were checked as the sections were read.
async function interpretSections(sheet: XlsxSheet, clock: SliceClock | undefined): Promise<void> {
	const cols: XlsxColRange[] = []
	let merges: Uint32Array = new Uint32Array(0)

	for (const section of sheet.sections) {
		switch (section.name) {
			case "sheetPr": {
				const document = await sectionDocument(sheet, section, clock)
				const tabColor = childByLocal(document, document.documentElement(), "tabColor")

				if (tabColor >= 0) sheet.tabColor = readColor(document, tabColor)

				break
			}
			case "sheetFormatPr": {
				const document = await sectionDocument(sheet, section, clock)

				sheet.format = readFormat(document, document.documentElement())

				break
			}
			case "sheetViews": {
				const document = await sectionDocument(sheet, section, clock)
				const view = childByLocal(document, document.documentElement(), "sheetView")

				if (view >= 0) sheet.view = readView(document, view)

				break
			}
			case "cols": {
				const document = await sectionDocument(sheet, section, clock)

				for (const col of childElements(document, document.documentElement())) {
					if (document.localName(col) !== "col") continue

					const range = readCol(document, col)

					if (range !== null) cols.push(range)
				}

				break
			}
			case "mergeCells":
				merges = await readMerges(sheet, section, merges, clock)

				break
			case "sheetProtection": {
				const document = await sectionDocument(sheet, section, clock)

				sheet.protection = readProtection(document, document.documentElement())

				break
			}
		}
	}

	sheet.cols = cols
	sheet.merges = merges
}

// Merges read between two looks at the clock.
const MERGES_PER_STEP = 4096

// The mergeCell refs of a mergeCells section, after `held`, read from its bytes with no tree: a sheet may hold a
// million of them. The section was walked whole as it was read, so its markup is known to be well formed.
async function readMerges(sheet: XlsxSheet, section: XlsxSection, held: Uint32Array, clock: SliceClock | undefined): Promise<Uint32Array> {
	const bytes = section.bytes ?? new Uint8Array(0)
	const scanner = new Scanner(bytes, sheet.part)
	const range = new Uint32Array(4)
	let at = scanner.tagEnd(0)

	if (scanner.selfClosing) return held

	let merges = new Uint32Array(held.length + 64)
	let count = held.length

	merges.set(held)

	for (let read = 1; ; read++) {
		const lt = bytes.indexOf(LT, at)

		if (lt < 0 || bytes[lt + 1] === SLASH) break

		const next = bytes[lt + 1]

		if (next === BANG || next === QUESTION) {
			at = scanner.markupEnd(lt)

			continue
		}

		const name = nameEnd(bytes, lt + 1)
		const tagEnd = scanner.tagEnd(lt)

		if (localIs(bytes, lt + 1, name, "mergeCell")) {
			let found = false

			scanner.attributes(lt, tagEnd, (nameStart, nameStop, valueStart, valueEnd) => {
				if (nameStop - nameStart !== 3 || !bytesAre(bytes, nameStart, nameStop, "ref")) return
				if (bytes.subarray(valueStart, valueEnd).includes(AMP)) {
					const parsed = parseRange(scanner.attributeValue(valueStart, valueEnd))

					found = parsed !== null

					if (parsed !== null) range.set([parsed.startRow, parsed.startCol, parsed.endRow, parsed.endCol])
				} else {
					found = rangeAt(bytes, valueStart, valueEnd, range)
				}
			})

			if (found) {
				if (count + 4 > merges.length) {
					const grown = new Uint32Array(merges.length * 2)

					grown.set(merges)
					merges = grown
				}

				merges.set(range, count)
				count += 4
			}
		}

		at = scanner.selfClosing ? tagEnd : scanner.elementEnd(lt)

		if (read % MERGES_PER_STEP === 0 && clock?.due === true) await clock.pause()
	}

	return merges.slice(0, count)
}

function readFormat(document: XmlDocument, node: number): XlsxSheetFormat {
	return {
		defaultRowHeight: numberAttribute(document, node, "defaultRowHeight") ?? 15,
		defaultColWidth: numberAttribute(document, node, "defaultColWidth") ?? Number.NaN,
		baseColWidth: intAttribute(document, node, "baseColWidth", 8),
		customHeight: booleanAttribute(document, node, "customHeight", false),
		zeroHeight: booleanAttribute(document, node, "zeroHeight", false),
		thickTop: booleanAttribute(document, node, "thickTop", false),
		thickBottom: booleanAttribute(document, node, "thickBottom", false),
		outlineLevelRow: intAttribute(document, node, "outlineLevelRow", 0),
		outlineLevelCol: intAttribute(document, node, "outlineLevelCol", 0)
	}
}

function readCol(document: XmlDocument, node: number): XlsxColRange | null {
	const min = intAttribute(document, node, "min", 0)
	const max = intAttribute(document, node, "max", min)

	if (min < 1 || max < min || min > SHEET_MAX_COLS) return null

	let flags = 0

	if (booleanAttribute(document, node, "hidden", false)) flags |= ColFlag.HIDDEN
	if (booleanAttribute(document, node, "customWidth", false)) flags |= ColFlag.CUSTOM_WIDTH
	if (booleanAttribute(document, node, "collapsed", false)) flags |= ColFlag.COLLAPSED
	if (booleanAttribute(document, node, "bestFit", false)) flags |= ColFlag.BEST_FIT
	if (booleanAttribute(document, node, "phonetic", false)) flags |= ColFlag.PHONETIC

	const level = intAttribute(document, node, "outlineLevel", 0)

	if (level > 0) flags |= Math.min(7, level) << ColFlag.OUTLINE_SHIFT

	return {
		first: min - 1,
		last: Math.min(max, SHEET_MAX_COLS) - 1,
		width: numberAttribute(document, node, "width") ?? Number.NaN,
		style: intAttribute(document, node, "style", -1),
		flags
	}
}

const VIEW_KINDS: ReadonlySet<string> = new Set(["normal", "pageLayout", "pageBreakPreview"])

export function readView(document: XmlDocument, node: number): XlsxSheetView {
	const pane = childByLocal(document, node, "pane")
	const state = pane < 0 ? undefined : document.attribute(pane, "state")
	const first = parseRange(document.attribute(node, "topLeftCell") ?? "")
	const topRow = first?.startRow ?? 0
	const leftCol = first?.startCol ?? 0
	let frozen: XlsxSheetView["frozen"] = null

	if (pane >= 0 && (state === "frozen" || state === "frozenSplit")) {
		// ySplit and xSplit count the rows and columns the top-left pane shows (MS-OI29500 §2.1.640 d), from the
		// view's first row and column.
		const rows = Math.max(0, Math.floor(numberAttribute(document, pane, "ySplit") ?? 0))
		const cols = Math.max(0, Math.floor(numberAttribute(document, pane, "xSplit") ?? 0))
		const topLeft = parseRange(document.attribute(pane, "topLeftCell") ?? "")

		frozen = { rows, cols, topLeftRow: topLeft?.startRow ?? topRow + rows, topLeftCol: topLeft?.startCol ?? leftCol + cols }
	}

	const activePane = pane < 0 ? undefined : (document.attribute(pane, "activePane") ?? "topLeft")
	let selectionNode = -1

	for (const child of childElements(document, node)) {
		if (document.localName(child) !== "selection") continue

		if (selectionNode < 0) selectionNode = child
		if ((document.attribute(child, "pane") ?? "topLeft") === activePane) {
			selectionNode = child

			break
		}
	}

	const active = selectionNode < 0 ? null : parseRange(document.attribute(selectionNode, "activeCell") ?? "")
	const selection: SheetRange[] = []

	if (selectionNode >= 0) {
		for (const part of (document.attribute(selectionNode, "sqref") ?? "").split(/\s+/)) {
			const range = part === "" ? null : parseRange(part)

			if (range !== null) selection.push(range)
			if (selection.length >= 1024) break
		}
	}

	const activeRow = active?.startRow ?? selection[0]?.startRow ?? 0
	const activeCol = active?.startCol ?? selection[0]?.startCol ?? 0
	const viewKind = document.attribute(node, "view") ?? "normal"

	return {
		frozen,
		topRow,
		leftCol,
		activeRow,
		activeCol,
		selection: selection.length > 0 ? selection : [{ startRow: activeRow, startCol: activeCol, endRow: activeRow, endCol: activeCol }],
		zoom: numberAttribute(document, node, "zoomScale") ?? 100,
		gridLines: booleanAttribute(document, node, "showGridLines", true),
		headings: booleanAttribute(document, node, "showRowColHeaders", true),
		rightToLeft: booleanAttribute(document, node, "rightToLeft", false),
		tabSelected: booleanAttribute(document, node, "tabSelected", false),
		view: VIEW_KINDS.has(viewKind) ? (viewKind as XlsxSheetView["view"]) : "normal"
	}
}

export function readProtectionHash(document: XmlDocument, node: number, prefix: string, legacyName: string): XlsxProtectionHash {
	const hash: { -readonly [K in keyof XlsxProtectionHash]: XlsxProtectionHash[K] } = {}
	const name = (local: string): string => (prefix === "" ? local : `${prefix}${local[0]?.toUpperCase() ?? ""}${local.slice(1)}`)
	const algorithmName = document.attribute(node, name("algorithmName"))
	const hashValue = document.attribute(node, name("hashValue"))
	const saltValue = document.attribute(node, name("saltValue"))
	const spinCount = numberAttribute(document, node, name("spinCount"))
	const legacy = document.attribute(node, legacyName)

	if (algorithmName !== undefined) hash.algorithmName = algorithmName
	if (hashValue !== undefined) hash.hashValue = hashValue
	if (saltValue !== undefined) hash.saltValue = saltValue
	if (spinCount !== undefined) hash.spinCount = spinCount
	if (legacy !== undefined) hash.legacy = legacy

	return hash
}

// §18.3.1.85: an attribute set to true protects its action; absent ones take the schema defaults.
const PROTECTED_DEFAULTS: readonly (readonly [SheetProtectedAction, boolean])[] = [
	["objects", false],
	["scenarios", false],
	["formatCells", true],
	["formatColumns", true],
	["formatRows", true],
	["insertColumns", true],
	["insertRows", true],
	["insertHyperlinks", true],
	["deleteColumns", true],
	["deleteRows", true],
	["selectLockedCells", false],
	["sort", true],
	["autoFilter", true],
	["pivotTables", true],
	["selectUnlockedCells", false]
]

function readProtection(document: XmlDocument, node: number): XlsxSheetProtection | null {
	if (!booleanAttribute(document, node, "sheet", false)) return null

	const allows = new Set<SheetProtectedAction>()

	for (const [action, protectedByDefault] of PROTECTED_DEFAULTS) {
		if (!booleanAttribute(document, node, action, protectedByDefault)) allows.add(action)
	}

	return { hash: readProtectionHash(document, node, "", "password"), allows }
}
