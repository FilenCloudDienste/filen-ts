import type { SheetStore } from "../../xlsx/model/store"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { CellKind, RowFlag, type XlsxSheetModel, type XlsxWorkbookModel } from "../../xlsx/model/types"
import { XlsxSheet } from "../../xlsx/read/worksheet"
import { RefRefused } from "../../xlsx/refs/catalogue"
import { refState } from "../../xlsx/refs/state"
import { attr, qualify, rootTag, spliceAttributes } from "../../xlsx/write/markup"
import { formatNumber } from "../../xlsx/write/text"
import { imageFormat, imageHandling } from "../../drawingml/picture"
import { chartSheetChart, type ChartSheetChart } from "../../xlsx/charts/sheets"
import { MAX_METAFILE_BYTES, convertMetafile } from "../../metafile/index"
import { visibleNotes } from "../../xlsx/comments/feature"
import { annotationStore } from "../../xlsx/comments/store"
import { compact, type SheetDrawingData } from "../../xlsx/drawings/render"
import { cloneModel } from "../../presentation/edit/changes"
import { decodeUtf8, encodeUtf8, parseXml } from "../../xml/index"
import { sectionMarkup } from "../cf/sections"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../registry"
import { AxisFlag, type SheetAxisLayout, type SheetId, type SheetRange } from "../protocol"
import { withRuns, type AxisRun } from "../axisRuns"
import { sliceClock, type Slicing } from "../../slicing"
import { paperSizeKnown } from "./paper"
import { readPageSetup, type SheetPageSetup, type SheetPrintMargins } from "./setup"

// Printing an xlsx sheet: its print settings as the file now holds them (with what a range prints when no print area
// is set), and the print dialog's choices written back into pageSetup, printOptions, pageMargins and sheetPr's
// pageSetUpPr, each as a splice of the element the file has (its other attributes, a printer settings part's r:id
// among them, kept).

// What the print dialog changes; a field left out keeps the file's value.
export interface SheetPrintPatch {
	readonly orientation?: "portrait" | "landscape"
	// ST_PaperSize (§18.3.1.63); a size the file gave as paperWidth and paperHeight is replaced by it.
	readonly paperSize?: number
	// A percent from 10 to 400: scaling instead of fitting.
	readonly scale?: number
	// Fit to `width` by `height` pages (0: any number on that axis) instead of scaling.
	readonly fit?: { readonly width: number; readonly height: number }
	readonly gridLines?: boolean
	readonly headings?: boolean
	readonly horizontalCentered?: boolean
	readonly verticalCentered?: boolean
	readonly margins?: SheetPrintMargins
}

export interface SheetPrintSetupResult {
	readonly setup: SheetPageSetup
	// What prints without a print area: the cells with a value or a formula, or whose format draws a fill or a border;
	// null when nothing does.
	readonly used: SheetRange | null
	// A chartsheet's chart, printed on a page of its own (no cells).
	readonly chart?: ChartSheetChart
}

// The rows' sizes for a print: the heights the file stores, in pixels kept fractional (a 15.5 pt row is 20.67 px; the
// grid's layout rounds it to 21). Only sizes and hidden rows: styles stay the layout's.
export type SheetPrintRows = SheetAxisLayout

// A note as a print shows it: its text, and for one shown all the time, the box its legacy drawing anchors it to
// (x:Anchor: left column, its offset in px, top row, offset, right column, offset, bottom row, offset).
export interface SheetPrintNote {
	readonly row: number
	readonly col: number
	readonly author: string
	readonly text: string
	readonly shown: boolean
	readonly anchor: readonly number[] | null
}

// A header or footer picture (&G) by its place: L, C or R, then H or F, then "" (odd pages), "FIRST" or "EVEN" — the
// shape ids Excel gives them in the sheet's legacy header drawing. Its size in points; a bitmap by its part, or a
// metafile drawn as a display list.
export interface SheetHeaderImage {
	readonly position: string
	readonly width: number
	readonly height: number
	readonly image: { readonly kind: "media"; readonly partName: string } | { readonly kind: "drawing"; readonly drawing: SheetDrawingData }
}

declare module "../protocol" {
	interface SheetQueryMap {
		"print.notes": { request: { readonly sheet: SheetId }; result: readonly SheetPrintNote[] }
		"print.headerImages": { request: { readonly sheet: SheetId }; result: readonly SheetHeaderImage[] }
		// null for a sheet that is not a worksheet.
		"print.rows": { request: { readonly sheet: SheetId }; result: SheetPrintRows | null }
		"print.settings": {
			request: { readonly sheet: SheetId }
			// null for a sheet that does not print (a dialog or macro sheet without cells here), or that is gone.
			result: SheetPrintSetupResult | null
		}
	}
	interface SheetCommandMap {
		"print.setup": { readonly sheet: SheetId; readonly patch: SheetPrintPatch }
	}
}

const PRINT_AREA = "_XLNM.PRINT_AREA"
const PRINT_TITLES = "_XLNM.PRINT_TITLES"

function nameFormula(workbook: XlsxWorkbookModel, sheet: SheetId, upper: string): string | null {
	return workbook.definedNames.find(name => name.sheet === sheet && name.name.toUpperCase() === upper)?.formula ?? null
}

function joined(workbook: XlsxWorkbookModel, model: XlsxSheetModel, name: string): string {
	return sectionMarkup(workbook, model, name).markup().join("")
}

export function sheetPageSetup(document: XlsxDocument, model: XlsxSheetModel): SheetPageSetup {
	const workbook = document.workbook

	return readPageSetup(
		{
			pageSetup: joined(workbook, model, "pageSetup"),
			pageMargins: joined(workbook, model, "pageMargins"),
			printOptions: joined(workbook, model, "printOptions"),
			headerFooter: joined(workbook, model, "headerFooter"),
			rowBreaks: joined(workbook, model, "rowBreaks"),
			colBreaks: joined(workbook, model, "colBreaks"),
			sheetPr: model.sections
				.filter(section => section.name === "sheetPr")
				.map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))
				.join("")
		},
		{ printArea: nameFormula(workbook, model.id, PRINT_AREA), printTitles: nameFormula(workbook, model.id, PRINT_TITLES) },
		model.fitToPage
	)
}

// A chartsheet's page (ECMA-376 Part 1 §18.3.1.12 chartsheet: pageMargins, pageSetup as CT_CsPageSetup, headerFooter)
// and its chart. Excel prints a chart sheet's chart on a page of its own, at the size the sheet gives it; its page
// setup offers paper, orientation and margins, no scaling (Microsoft Support, "Print a chart").
async function chartsheetSettings(document: XlsxDocument, sheet: SheetId, part: string): Promise<SheetPrintSetupResult | null> {
	const chart = await chartSheetChart(document, sheet)

	if (chart === null) return null

	const markup = { pageSetup: "", pageMargins: "", headerFooter: "" }

	try {
		const bytes = part === "" ? null : await document.workbook.parts.read(part)

		if (bytes !== null && bytes !== undefined) {
			const xml = parseXml(bytes)
			const root = xml.documentElement()

			for (let child = xml.firstChildElement(root); child >= 0; child = xml.nextSiblingElement(child)) {
				const name = xml.localName(child)

				if (name === "pageSetup" || name === "pageMargins" || name === "headerFooter") markup[name] = decodeUtf8(xml.raw(child))
			}
		}
	} catch {
		// A chartsheet whose part does not read prints with the defaults.
	}

	const setup = readPageSetup(
		{ ...markup, printOptions: "", rowBreaks: "", colBreaks: "", sheetPr: "" },
		{ printArea: null, printTitles: null },
		false
	)

	return { setup, used: null, chart }
}

// Whether each cell format draws on paper: a fill, or a border line.
function drawingFormats(document: XlsxDocument): Uint8Array {
	const styles = document.workbook.styles
	const out = new Uint8Array(styles.cellXfs.length)

	styles.cellXfs.forEach((xf, index) => {
		const fill = styles.fills[xf.fillId]
		const border = styles.borders[xf.borderId]
		const fills = fill !== undefined && (fill.kind === "gradient" || fill.pattern !== "none")
		const lines =
			border !== undefined &&
			[border.left, border.right, border.top, border.bottom, border.diagonal].some(edge => edge?.style !== undefined)

		out[index] = fills || lines ? 1 : 0
	})

	return out
}

// The used range a print takes: the cells that show something on paper. Rows and columns of a format alone (a styled
// row, a whole formatted column) print only where a cell holds something, as Excel's own print area does.
export function printedRange(document: XlsxDocument, model: XlsxSheetModel): SheetRange | null {
	const store = model.store as SheetStore
	const draws = drawingFormats(document)
	let startRow = -1
	let endRow = -1
	let startCol = Number.MAX_SAFE_INTEGER
	let endCol = -1

	for (const block of store.blocks) {
		for (let i = 0; i < block.rowCount; i++) {
			const from = block.rowStarts[i] ?? 0
			const to = block.rowStarts[i + 1] ?? from
			let shows = false

			for (let k = from; k < to; k++) {
				if (block.kinds[k] === CellKind.EMPTY && (block.formulas?.[k] ?? -1) < 0 && draws[block.styles[k] ?? 0] !== 1) continue

				const col = block.cols[k] ?? 0

				shows = true
				startCol = Math.min(startCol, col)
				endCol = Math.max(endCol, col)
			}

			if (!shows) continue

			const row = block.firstRow + (block.rows[i] ?? 0)

			if (startRow < 0) startRow = row

			endRow = row
		}
	}

	// Merged cells print whole.
	const merges = model.merges

	if (startRow >= 0) {
		for (let k = 0; k + 3 < merges.length; k += 4) {
			const top = merges[k] ?? 0
			const left = merges[k + 1] ?? 0
			const bottom = merges[k + 2] ?? 0
			const right = merges[k + 3] ?? 0

			if (top <= endRow && bottom >= startRow && left <= endCol && right >= startCol) {
				endRow = Math.max(endRow, bottom)
				endCol = Math.max(endCol, right)
			}
		}
	}

	// A used range starts at A1 when it starts anywhere (Excel prints the blank rows and columns before the first cell).
	return startRow < 0 ? null : { startRow: 0, startCol: 0, endRow, endCol }
}

function elementPrefix(model: XlsxSheetModel): string | null {
	if (model instanceof XlsxSheet) return model.prefix
	if (model.freshRoot !== undefined) return rootTag(encodeUtf8(model.freshRoot)).prefix

	return null
}

// An element with `updates` spliced into its attributes, or a new one holding them.
function withAttributes(markup: string, name: string, updates: ReadonlyMap<string, string | null>): string {
	if (markup === "") {
		let out = `<${name}`

		for (const [attribute, value] of updates) if (value !== null) out += attr(attribute, value)

		return `${out}/>`
	}

	return decodeUtf8(spliceAttributes(encodeUtf8(markup), updates))
}

const MARGIN_NAMES: readonly (keyof SheetPrintMargins)[] = ["left", "right", "top", "bottom", "header", "footer"]

function validPatch(patch: SheetPrintPatch): boolean {
	const whole = (value: number, low: number, high: number): boolean => Number.isInteger(value) && value >= low && value <= high

	if (patch.paperSize !== undefined && !paperSizeKnown(patch.paperSize)) return false
	if (patch.scale !== undefined && !whole(patch.scale, 10, 400)) return false
	if (patch.fit !== undefined && (!whole(patch.fit.width, 0, 32_767) || !whole(patch.fit.height, 0, 32_767))) return false
	if (patch.scale !== undefined && patch.fit !== undefined) return false
	if (
		patch.margins !== undefined &&
		!MARGIN_NAMES.every(
			name => Number.isFinite(patch.margins?.[name]) && (patch.margins?.[name] ?? -1) >= 0 && (patch.margins?.[name] ?? 50) < 50
		)
	)
		return false

	return true
}

interface PrintSections {
	readonly pageSetup: readonly string[]
	readonly printOptions: readonly string[]
	readonly pageMargins: readonly string[]
	readonly fitToPage: boolean | undefined
}

export function setPrintSetup(document: XlsxDocument, sheet: SheetId, patch: SheetPrintPatch, changes: SheetChangeSink): SheetHandled {
	const model = document.model(sheet)

	if (model === null || document.entry(sheet)?.kind !== "worksheet") return { refused: { reason: "unsupported", detail: "sheet" } }
	if (!validPatch(patch)) return { refused: { reason: "tooLarge", detail: "print" } }

	const prefix = elementPrefix(model)

	if (prefix === null) return { refused: { reason: "unsupported", detail: "print" } }

	const workbook = document.workbook
	const state = refState(workbook)
	let before: PrintSections

	try {
		before = {
			pageSetup: state.sectionMarkup(model, "pageSetup"),
			printOptions: state.sectionMarkup(model, "printOptions"),
			pageMargins: state.sectionMarkup(model, "pageMargins"),
			fitToPage: model.fitToPage
		}
	} catch (error) {
		if (error instanceof RefRefused) return { refused: error.refusal }

		throw error
	}

	const current = sheetPageSetup(document, model)
	const page = new Map<string, string | null>()
	const options = new Map<string, string | null>()
	let fitToPage = before.fitToPage

	if (patch.orientation !== undefined && patch.orientation !== current.orientation) page.set("orientation", patch.orientation)
	if (patch.paperSize !== undefined && (current.customPaper || patch.paperSize !== current.paperSize)) {
		page.set("paperSize", String(patch.paperSize))
		page.set("paperWidth", null)
		page.set("paperHeight", null)
	}

	if (patch.scale !== undefined) {
		if (patch.scale !== current.scale) page.set("scale", String(patch.scale))
		if (current.fitToPage) fitToPage = false
	}

	if (patch.fit !== undefined) {
		if (patch.fit.width !== current.fitToWidth) page.set("fitToWidth", patch.fit.width === 1 ? null : String(patch.fit.width))
		if (patch.fit.height !== current.fitToHeight) page.set("fitToHeight", patch.fit.height === 1 ? null : String(patch.fit.height))
		if (!current.fitToPage) fitToPage = true
	}

	const option = (name: "gridLines" | "headings" | "horizontalCentered" | "verticalCentered"): void => {
		const value = patch[name]

		if (value !== undefined && value !== current[name]) options.set(name, value ? "1" : null)
	}

	option("gridLines")
	option("headings")
	option("horizontalCentered")
	option("verticalCentered")

	const margins = patch.margins
	const marginsChanged = margins !== undefined && MARGIN_NAMES.some(name => margins[name] !== current.margins[name])
	const one = (occurrences: readonly string[]): string => occurrences.join("")
	const after: PrintSections = {
		pageSetup: page.size === 0 ? before.pageSetup : [withAttributes(one(before.pageSetup), qualify(prefix, "pageSetup"), page)],
		printOptions:
			options.size === 0 ? before.printOptions : [withAttributes(one(before.printOptions), qualify(prefix, "printOptions"), options)],
		pageMargins:
			margins === undefined || !marginsChanged
				? before.pageMargins
				: [
						withAttributes(
							one(before.pageMargins),
							qualify(prefix, "pageMargins"),
							new Map(MARGIN_NAMES.map(name => [name, formatNumber(margins[name])]))
						)
					],
		fitToPage
	}

	if (
		after.pageSetup === before.pageSetup &&
		after.printOptions === before.printOptions &&
		after.pageMargins === before.pageMargins &&
		after.fitToPage === before.fitToPage
	)
		return null

	const apply = (sections: PrintSections, sink: SheetChangeSink): void => {
		if (after.pageSetup !== before.pageSetup) state.setSection(model, "pageSetup", sections.pageSetup)
		if (after.printOptions !== before.printOptions) state.setSection(model, "printOptions", sections.printOptions)
		if (after.pageMargins !== before.pageMargins) state.setSection(model, "pageMargins", sections.pageMargins)
		if (after.fitToPage !== before.fitToPage) {
			if (sections.fitToPage === undefined) delete model.fitToPage
			else model.fitToPage = sections.fitToPage

			workbook.changes.sheetSection(model.id, "sheetPr")
		}

		sink.layout(sheet)
	}

	apply(after, changes)

	const size = (sections: PrintSections): number =>
		one(sections.pageSetup).length + one(sections.printOptions).length + one(sections.pageMargins).length

	return {
		bytes: 2 * (size(before) + size(after)) + 64,
		undo: sink => {
			apply(before, sink)
		},
		redo: sink => {
			apply(after, sink)
		}
	}
}

// The sheet's notes with their text, in row then column order (threaded comments' placeholders included: their text
// is the thread's).
async function printNotes(document: XlsxDocument, sheet: SheetId): Promise<SheetPrintNote[]> {
	if (document.entry(sheet)?.kind !== "worksheet") return []

	const store = annotationStore(document.workbook)

	try {
		await store.load(document, sheet)
		await document.ready(sheet)
	} catch {
		return []
	}

	const notes = visibleNotes(store, sheet)
	const vml = store.vmlOf(sheet)

	if (notes === null) return []

	const out: SheetPrintNote[] = []

	for (const [key, note] of notes.part.notes) {
		if (!notes.shows(note)) continue

		const shape = vml?.notes.get(key)
		let anchor: number[] | null = null

		if (vml !== null && shape !== undefined && shape.clientData >= 0) {
			for (let child = vml.document.firstChildElement(shape.clientData); child >= 0; child = vml.document.nextSiblingElement(child)) {
				if (vml.document.localName(child) !== "Anchor") continue

				const values = vml.document
					.textContent(child)
					.split(",")
					.map(value => Number(value.trim()))

				if (values.length === 8 && values.every(value => Number.isInteger(value) && value >= 0)) anchor = values
			}
		}

		out.push({ row: note.row, col: note.col, author: note.author, text: note.text, shown: shape?.shown === true, anchor })
	}

	return out.sort((a, b) => a.row - b.row || a.col - b.col)
}

const HEADER_POSITIONS = /^[LCR][HF](?:FIRST|EVEN)?$/
const POINT_UNITS: Readonly<Record<string, number>> = { pt: 1, px: 0.75, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, pc: 12 }

function stylePoints(style: string, name: string): number | null {
	const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([0-9.]+)\\s*(pt|px|in|mm|cm|pc)?`, "i").exec(style)

	if (match === null) return null

	const value = Number(match[1]) * (POINT_UNITS[(match[2] ?? "px").toLowerCase()] ?? 0.75)

	return Number.isFinite(value) && value > 0 ? value : null
}

// The header pictures last read per document, by the sheet's part and its legacyDrawingHF: they come from source parts,
// which never change, so the print dialog's every change reuses them instead of converting the metafiles again.
const HEADER_IMAGES_KEPT = 4
const headerImagesRead = new WeakMap<XlsxDocument, Map<string, Promise<SheetHeaderImage[]>>>()

// The sheet's header and footer pictures: the shapes of the legacy drawing its legacyDrawingHF names.
async function headerImages(document: XlsxDocument, sheet: SheetId): Promise<SheetHeaderImage[]> {
	if (document.entry(sheet)?.kind !== "worksheet") return []

	const model = await document.ready(sheet)
	const markup = joined(document.workbook, model, "legacyDrawingHF")

	if (markup === "") return []

	let kept = headerImagesRead.get(document)

	if (kept === undefined) {
		kept = new Map()
		headerImagesRead.set(document, kept)
	}

	const key = `${model.part}\n${markup}`
	const held = kept.get(key)

	if (held !== undefined) {
		// Most recently used last.
		kept.delete(key)
		kept.set(key, held)

		return ownedImages(await held)
	}

	const read = readHeaderImages(document.workbook, model, markup)

	kept.set(key, read)

	for (const oldest of kept.keys()) {
		if (kept.size <= HEADER_IMAGES_KEPT) break

		kept.delete(oldest)
	}

	return ownedImages(await read)
}

// Answers of their own: a worker transfers every answer's buffers (protocol.ts), which would leave the kept drawings
// detached for the next print. Bitmap pictures are part names, with nothing to copy.
function ownedImages(images: SheetHeaderImage[]): SheetHeaderImage[] {
	return images.map(entry => (entry.image.kind === "drawing" ? { ...entry, image: cloneModel(entry.image) } : entry))
}

async function readHeaderImages(workbook: XlsxWorkbookModel, model: XlsxSheetModel, markup: string): Promise<SheetHeaderImage[]> {
	try {
		const element = parseXml(encodeUtf8(markup))
		const root = element.documentElement()
		const id = element.attributes(root).find(attribute => attribute.name.endsWith(":id") || attribute.name === "id")?.value

		if (id === undefined) return []

		const part = (await workbook.parts.relationships(model.part)).byId(id)?.partName

		if (part === undefined || workbook.parts.get(part) === undefined) return []

		const vml = parseXml(await workbook.parts.read(part))
		const relationships = await workbook.parts.relationships(part)
		const out: SheetHeaderImage[] = []
		const walk = (node: number): void => {
			for (let child = vml.firstChildElement(node); child >= 0; child = vml.nextSiblingElement(child)) {
				if (vml.localName(child) !== "shape") {
					walk(child)

					continue
				}

				const position = (vml.attribute(child, "id") ?? "").toUpperCase()
				const style = vml.attribute(child, "style") ?? ""
				const width = stylePoints(style, "width")
				const height = stylePoints(style, "height")

				if (!HEADER_POSITIONS.test(position) || width === null || height === null) continue

				for (let data = vml.firstChildElement(child); data >= 0; data = vml.nextSiblingElement(data)) {
					if (vml.localName(data) !== "imagedata") continue

					const relid = vml
						.attributes(data)
						.find(attribute => attribute.name.endsWith("relid") || attribute.name.endsWith(":id"))?.value
					const image = relid === undefined ? undefined : relationships.byId(relid)?.partName

					if (image !== undefined) out.push({ position, width, height, image: { kind: "media", partName: image } })
				}
			}
		}

		walk(vml.documentElement())

		// Metafiles drawn as display lists; other pictures stay parts the renderer asks for (drawing.media).
		return await Promise.all(
			out.map(async entry => {
				if (entry.image.kind !== "media") return entry

				const contentType = workbook.parts.get(entry.image.partName)?.contentType
				const format = imageFormat(entry.image.partName, contentType)

				if (imageHandling(format) !== "metafile") return entry

				// Refused by its stored size before anything is inflated; a stored size can lie, so the bytes are checked too.
				if ((workbook.parts.get(entry.image.partName)?.source?.uncompressedSize ?? 0) > MAX_METAFILE_BYTES) return null

				const bytes = await workbook.parts.read(entry.image.partName)

				if (bytes.length > MAX_METAFILE_BYTES) return null

				const converted = convertMetafile(bytes)

				return converted.ok ? { ...entry, image: { kind: "drawing" as const, drawing: compact(converted.list) } } : null
			})
		).then(entries => entries.filter((entry): entry is SheetHeaderImage => entry !== null))
	} catch {
		// A header drawing that does not read prints no pictures (the file keeps it as it was).
		return []
	}
}

const PX_PER_POINT = 4 / 3

// The rows' axis per document, by sheet, for the session version it was built at: the print dialog lays out again on
// every change of its choices, and the rows only change with an edit.
const rowsBuilt = new WeakMap<XlsxDocument, Map<SheetId, { readonly version: number; readonly rows: SheetPrintRows }>>()

// A worker host gives no slices: its turns are a macrotask each, so requests are taken in between.
const WORKER_SLICING: Slicing = {
	sliceMs: 16,
	now: () => Date.now(),
	pause: () =>
		new Promise<void>(resolve => {
			const timer: unknown = Reflect.get(globalThis, "setTimeout")

			if (typeof timer === "function") (timer as (callback: () => void, ms: number) => void)(resolve, 0)
			else resolve()
		})
}

// Rows between looks at the slice clock.
const ROWS_PER_LOOK = 4096

// One pass over the sheet's rows in order (the store's blocks are), no sort, in slices (the session runs its calls one
// at a time, so nothing changes the rows meanwhile).
async function printRows(
	document: XlsxDocument,
	sheet: SheetId,
	version: number,
	slicing: Slicing | undefined
): Promise<SheetPrintRows | null> {
	if (document.entry(sheet)?.kind !== "worksheet") return null

	let built = rowsBuilt.get(document)

	if (built === undefined) {
		built = new Map()
		rowsBuilt.set(document, built)
	}

	const held = built.get(sheet)

	if (held?.version === version) return ownedRows(held.rows)

	const model = await document.ready(sheet)
	const store = model.store as SheetStore
	const defaultSize = model.format.defaultRowHeight * PX_PER_POINT
	let count = 0

	for (const block of store.blocks) count += block.rowCount

	const indices = new Uint32Array(count)
	const sizes = new Float32Array(count)
	const flags = new Uint16Array(count)
	let n = 0
	let visited = 0
	let looked = 0
	const clock = sliceClock(slicing ?? WORKER_SLICING)

	for (const block of store.blocks) {
		visited += block.rowCount

		if (visited - looked >= ROWS_PER_LOOK) {
			looked = visited

			if (clock.due) await clock.pause()
		}

		for (let i = 0; i < block.rowCount; i++) {
			const height = block.rowHeights[i] ?? Number.NaN
			const size = Number.isNaN(height) ? defaultSize : height * PX_PER_POINT
			const hidden = ((block.rowFlags[i] ?? 0) & RowFlag.HIDDEN) !== 0

			if (!hidden && size === defaultSize) continue

			indices[n] = block.firstRow + (block.rows[i] ?? 0)
			sizes[n] = size
			flags[n] = hidden ? AxisFlag.HIDDEN : 0
			n++
		}
	}

	// Rows the store does not hold (an OpenDocument sheet's runs): an entry each.
	const runs: AxisRun[] = []

	for (const run of model.rowRuns ?? []) {
		const size = Number.isNaN(run.heightPt) ? defaultSize : run.heightPt * PX_PER_POINT
		const hidden = (run.flags & RowFlag.HIDDEN) !== 0

		if (hidden || size !== defaultSize)
			runs.push({ first: run.first, count: run.last - run.first + 1, size, style: 0, flags: hidden ? AxisFlag.HIDDEN : 0 })
	}

	const rows: SheetPrintRows =
		runs.length === 0
			? { defaultSize, indices: indices.slice(0, n), sizes: sizes.slice(0, n), styles: new Uint32Array(n), flags: flags.slice(0, n) }
			: withRuns(
					defaultSize,
					[...indices.subarray(0, n)],
					[...sizes.subarray(0, n)],
					new Array<number>(n).fill(0),
					[...flags.subarray(0, n)],
					runs
				)

	built.set(sheet, { version, rows })

	return ownedRows(rows)
}

// An answer of its own: a worker transfers every answer's buffers (protocol.ts), which would leave the kept rows
// detached for the next print.
function ownedRows(rows: SheetPrintRows): SheetPrintRows {
	return {
		...rows,
		indices: rows.indices.slice(),
		sizes: rows.sizes.slice(),
		styles: rows.styles.slice(),
		flags: rows.flags.slice(),
		...(rows.counts !== undefined && { counts: rows.counts.slice() })
	}
}

export const xlsxPrintFeature = defineSheetFeature<XlsxDocument>({
	id: "print",
	queries: {
		"print.notes": { run: (context, request) => printNotes(context.doc, request.sheet) },
		"print.headerImages": { run: (context, request) => headerImages(context.doc, request.sheet) },
		"print.rows": { run: (context, request) => printRows(context.doc, request.sheet, context.version, context.slicing) },
		"print.settings": {
			run: async (context, request) => {
				const entry = context.doc.entry(request.sheet)

				if (entry?.kind === "chartsheet") return chartsheetSettings(context.doc, request.sheet, entry.part)
				if (entry === undefined || entry.kind !== "worksheet") return null

				const model = await context.doc.ready(request.sheet, context.slicing)

				return { setup: sheetPageSetup(context.doc, model), used: printedRange(context.doc, model) }
			}
		}
	},
	commands: {
		"print.setup": {
			info: { write: true },
			run: (context, command) => setPrintSetup(context.doc, command.sheet, command.patch, context.changes)
		}
	}
})
