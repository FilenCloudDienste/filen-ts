import { CellFlag, type SheetId, type SheetRange, type SheetRenderStyle, type SheetTile } from "../../../core/sheet/protocol"
import { parseHeaderFooter } from "../../../core/sheet/print/headerFooter"
import { chartPagination, type PrintPage } from "../../../core/sheet/print/paginate"
import type { SheetPageSetup } from "../../../core/sheet/print/setup"
import type { SheetHeaderImage, SheetPrintNote } from "../../../core/sheet/print/xlsx"
import { columnName } from "../../../core/sheet/refs/cellRef"
import type { SheetDrawingObject } from "../../../core/xlsx/drawings/feature"
import { DocxMediaCache } from "../../docx/media"
import type { SheetGridModel } from "../model"
import { printAxis, printSheet, type PrintedSheet } from "./printPage"
import { printRanges } from "./printRanges"

// A print laid out without drawing anything: the sheets cut into pages, the notes listed after them, and the looks
// a page prints its tiles with. Free of the DOM, so the PDF export runs it in a worker; the SVG print draws from it.

export interface PrintSheetRequest {
	readonly sheet: SheetId
	readonly name: string
	readonly setup: SheetPageSetup
	// What prints: the selection's ranges, else the print area's, else the used range (null: nothing).
	readonly ranges: readonly SheetRange[]
	readonly used: SheetRange | null
	// A chartsheet's chart (print.settings): the sheet prints it on a page of its own instead of cells.
	readonly chart?: PrintChart
	// The words the print adds, in the app's language (English without them).
	readonly labels?: PrintLabels
}

// The words a print adds to the sheet. Templates: "{cell}" is a cell's reference, "{note}" a note's text, "{name}" a
// sheet's name.
export interface PrintLabels {
	// The notes listed at the end: a note's cell, and its text.
	readonly cell: string
	readonly note: string
	// A tagged PDF's alternative text for a chart or a picture that names none, and for a chartsheet's chart.
	readonly chart: string
	readonly picture: string
	readonly chartSheet: string
}

export const PRINT_LABELS: PrintLabels = {
	cell: "Cell: {cell}",
	note: "Note: {note}",
	chart: "Chart",
	picture: "Picture",
	chartSheet: "Chart: {name}"
}

// A label's template with its `field` filled in.
export function labelText(template: string, field: "cell" | "note" | "name", value: string): string {
	return template.replace(`{${field}}`, () => value)
}

export interface PrintLayoutOptions {
	// The family the notes listed at the end are measured and drawn in (default: the workbook's own, its base style's).
	readonly family?: string
	// Told the family and the texts of the notes list before they are measured (a measurer that loads faces first).
	readonly prepare?: (family: string, texts: readonly string[]) => Promise<void>
}

// A chartsheet's chart part and its size (EMU).
export interface PrintChart {
	readonly part: string
	readonly width: number
	readonly height: number
}

// A page listing notes: each note's cell and its text, in lines as they fit the page, in the family they were
// measured in (listFamilies).
export interface NotesPage {
	readonly lines: readonly { readonly text: string; readonly bold: boolean }[]
	readonly family: string
}

export interface PrintJobSheet extends PrintedSheet {
	readonly notesAtEnd: readonly NotesPage[]
	// Notes shown all the time, drawn where they stand (cellComments asDisplayed).
	readonly shownNotes: readonly SheetPrintNote[]
	readonly objects: readonly SheetDrawingObject[]
	readonly headerImages: readonly SheetHeaderImage[]
	readonly chart: PrintChart | null
	readonly labels: PrintLabels
}

export interface PrintJob {
	readonly model: SheetGridModel
	readonly sheets: readonly PrintJobSheet[]
	// The print was laid out up to its page cap and more pages would follow.
	readonly more: boolean
	readonly measure: (font: string, text: string) => number
	// Pictures as object URLs for the print's lifetime.
	readonly media: DocxMediaCache | null
	// Drawn objects, once per object.
	readonly drawn: Map<string, Promise<string | null>>
	dispose(): void
}

// Cells with content a printed page may hold (those inside it: its rows and columns, and the title rows and columns
// repeated on it). A page past it is refused, nothing of it drawn: a bound against a file made to print one page for
// ever, which no print of a real sheet reaches. The fullest page a named paper size gives is E (34 by 44 in, the
// largest of pageSetup's paperSize, ECMA-376 Part 1 §18.3.1.63) at the least scale (10 %) with default rows (15 pt)
// and columns (48 pt): 2,112 rows by 510 columns, 1,077,120 cells. This is twice that.
// Large pages are drawn in slices (printSlices.ts), so what a page holds costs time and output, not working memory.
export const MAX_PAGE_CELLS = 2_097_152

// A page holding more than MAX_PAGE_CELLS: the print or PDF is refused there, nothing drawn. `page` counts from 1.
export class PrintPageTooLarge extends Error {
	override readonly name = "PrintPageTooLarge"
	readonly page: number

	constructor(page: number) {
		super(`Page ${String(page)} holds more cells than a printed page is drawn with`)
		this.page = page
	}
}

export const NOTE_FONT_PX = 12
export const NOTE_FONT = `${String(NOTE_FONT_PX)}px Tahoma, Arial, sans-serif`
export const NOTE_LINE_PX = 15
export const LIST_FONT_PT = 10
export const LIST_LINE_PT = 14

// The notes list's families as CSS names them: the sheet's own, then the faces that stand in for Calibri.
export function listFamilies(family: string): string {
	return `"${family.replace(/["\\]/g, "")}", Calibri, Carlito, Arial, sans-serif`
}

// The notes list's font in px (a PDF canvas reads px only; 10 pt is 4/3 as many px).
export function listFont(family: string): string {
	return `${String((LIST_FONT_PT * 4) / 3)}px ${listFamilies(family)}`
}

// A note as the list prints it: its cell's line, and its text (the author's name before it unless it starts with it).
function noteLines(note: SheetPrintNote, labels: PrintLabels): { readonly cell: string; readonly text: string } {
	const body = note.author === "" || note.text.startsWith(note.author) ? note.text : `${note.author}: ${note.text}`

	return {
		cell: labelText(labels.cell, "cell", `${columnName(note.col)}${String(note.row + 1)}`),
		text: labelText(labels.note, "note", body)
	}
}

// `text` broken into lines `width` wide at spaces (a long word between characters); line breaks kept.
export function wrap(text: string, width: number, measure: (text: string) => number): string[] {
	const out: string[] = []

	for (const paragraph of text.split(/\r?\n|\r/u)) {
		let line = ""

		for (const word of paragraph.match(/\S+\s*|\s+/gu) ?? [""]) {
			if (line !== "" && measure(line + word.trimEnd()) > width) {
				out.push(line.trimEnd())
				line = ""
			}

			if (measure(word.trimEnd()) <= width || line !== "") {
				line += word

				continue
			}

			for (const char of word) {
				if (line !== "" && measure(line + char) > width) {
					out.push(line)
					line = ""
				}

				line += char
			}
		}

		out.push(line.trimEnd())
	}

	return out
}

// The notes listed after a sheet, as Excel prints them: a "Cell:" line and a "Note:" line each, a blank line between;
// measured in the font they are drawn in (listFont).
function notesPages(
	notes: readonly SheetPrintNote[],
	printed: PrintedSheet,
	measure: (font: string, text: string) => number,
	family: string,
	labels: PrintLabels
): NotesPage[] {
	if (notes.length === 0) return []

	const { area } = printed.pagination
	const font = listFont(family)
	const perPage = Math.max(1, Math.floor(area.height / LIST_LINE_PT))
	const lines: { text: string; bold: boolean }[] = []

	for (const note of notes) {
		if (lines.length > 0) lines.push({ text: "", bold: false })

		const { cell, text } = noteLines(note, labels)

		lines.push({ text: cell, bold: true })

		// Measured in px: the list's points are 4/3 as many px.
		for (const line of wrap(text, (area.width * 4) / 3, piece => measure(font, piece))) lines.push({ text: line, bold: false })
	}

	const pages: NotesPage[] = []

	for (let k = 0; k < lines.length; k += perPage) pages.push({ lines: lines.slice(k, k + perPage), family })

	return pages
}

// Whether any header or footer text of the sheet shows a picture (&G).
function picturesUsed(setup: SheetPageSetup): boolean {
	const { odd, even, first } = setup.headerFooter

	return [odd.header, odd.footer, even.header, even.footer, first.header, first.footer].some(text =>
		Object.values(parseHeaderFooter(text)).some((runs: readonly { kind: string; field?: string }[]) =>
			runs.some(run => run.kind === "field" && run.field === "picture")
		)
	)
}

// `maxPages`: the sheets' pages laid out at most, all sheets together (what a browser can print), so a huge range
// is not cut into pages nothing shows; the job says when more would follow.
export async function layOutPrint(
	model: SheetGridModel,
	sheets: readonly PrintSheetRequest[],
	measure: (font: string, text: string) => number = (_font, text) => text.length * 7,
	maxPages?: number,
	options: PrintLayoutOptions = {}
): Promise<PrintJob> {
	const out: PrintJobSheet[] = []
	const family = options.family ?? familyOf(model.style(0).font)
	let left = maxPages ?? Number.POSITIVE_INFINITY
	let more = false
	const xlsx = model.kind !== "csv" && model.kind !== "tsv" && model.kind !== "tab"
	let media: DocxMediaCache | null = null

	for (const request of sheets) {
		// The session's own layout: it carries what features read beside the sheet (drawings) as they now are.
		const layout = await model.session.layout(request.sheet)

		if (request.chart !== undefined) {
			if (left <= 0) {
				more = true

				break
			}

			left -= 1
			media ??= new DocxMediaCache({ media: partName => model.session.query("drawing.media", { partName }) })
			out.push({
				sheet: request.sheet,
				name: request.name,
				layout,
				rowSizes: layout.rows,
				setup: request.setup,
				pagination: chartPagination(request.setup),
				rows: printAxis(layout.rows, 1),
				cols: printAxis(layout.cols, 1),
				notesAtEnd: [],
				shownNotes: [],
				objects: [],
				headerImages: [],
				chart: request.chart,
				labels: request.labels ?? PRINT_LABELS
			})

			continue
		}

		const { setup } = request
		// Draft quality prints no graphics.
		const objects = setup.draft ? [] : (layout.extensions?.drawings?.objects.filter(object => !object.hidden) ?? [])
		const notes = xlsx && setup.cellComments !== "none" ? await model.session.query("print.notes", { sheet: request.sheet }) : []
		const shownNotes = setup.cellComments === "asDisplayed" ? notes.filter(note => note.shown) : []
		const ranges = printRanges(request.ranges, request.used, objects, shownNotes, layout)
		const headerImages =
			xlsx && !setup.draft && picturesUsed(setup) ? await model.session.query("print.headerImages", { sheet: request.sheet }) : []
		const notesAtEnd = setup.cellComments === "atEnd" ? notes : []

		if (ranges.length === 0 && notesAtEnd.length === 0) continue

		if (left <= 0) {
			more = true

			break
		}

		const exact = xlsx ? await model.session.query("print.rows", { sheet: request.sheet }) : null
		const printed = printSheet(request.sheet, request.name, layout, setup, ranges, Number.isFinite(left) ? left : undefined, exact)

		left -= printed.pagination.pages.length
		more ||= printed.pagination.more

		if (objects.length > 0 || headerImages.length > 0)
			media ??= new DocxMediaCache({ media: partName => model.session.query("drawing.media", { partName }) })

		const labels = request.labels ?? PRINT_LABELS

		if (notesAtEnd.length > 0 && options.prepare !== undefined)
			await options.prepare(
				family,
				notesAtEnd.flatMap(note => Object.values(noteLines(note, labels)))
			)

		out.push({
			...printed,
			notesAtEnd: notesPages(notesAtEnd, printed, measure, family, labels),
			shownNotes,
			objects,
			headerImages,
			chart: null,
			labels
		})
	}

	const drawn = new Map<string, Promise<string | null>>()

	return {
		model,
		sheets: out,
		more,
		measure,
		media,
		drawn,
		dispose: () => {
			media?.dispose()
			drawn.clear()
		}
	}
}

// A family the workbook names, else Calibri (Excel's default).
function familyOf(name: string | undefined): string {
	return name === undefined || name === "" ? "Calibri" : name
}

function sheetPages(sheet: PrintJobSheet): number {
	return sheet.pagination.pages.length + sheet.notesAtEnd.length
}

export function pageCount(job: PrintJob): number {
	return job.sheets.reduce((total, sheet) => total + sheetPages(sheet), 0)
}

// The nth page of a print (0-based) with its sheet, its number (&P) and whether it is its sheet's first: a page of
// cells, or one listing notes.
export function printPageAt(
	job: PrintJob,
	index: number
): {
	readonly sheet: PrintJobSheet
	readonly page: PrintPage | null
	readonly notes: NotesPage | null
	readonly number: number
	readonly first: boolean
} | null {
	let before = 0
	let number = 0

	for (const sheet of job.sheets) {
		const pages = sheet.pagination.pages
		const count = sheetPages(sheet)
		const start = sheet.setup.firstPageNumber ?? number + 1

		if (index < before + count) {
			const at = index - before
			const page = at < pages.length ? (pages[at] ?? null) : null
			const notes = at >= pages.length ? (sheet.notesAtEnd[at - pages.length] ?? null) : null

			return { sheet, page, notes, number: start + at, first: at === 0 }
		}

		before += count
		number = start + count - 1
	}

	return null
}

const ERROR_TEXTS: Readonly<Record<SheetPageSetup["errors"], string | null>> = { displayed: null, blank: "", dash: "--", NA: "#N/A" }

// A tile with its error values as the sheet prints them (pageSetup errors, §18.18.60).
export function printedTile(tile: SheetTile, errors: SheetPageSetup["errors"]): SheetTile {
	const replacement = ERROR_TEXTS[errors]

	if (replacement === null) return tile

	let texts: Int32Array | null = null
	let strings: string[] | null = null
	let index = -1

	for (let entry = 0; entry < tile.count; entry++) {
		if (((tile.flags[entry] ?? 0) & CellFlag.ERROR) === 0) continue

		texts ??= tile.texts.slice()

		if (replacement === "") {
			texts[entry] = -1

			continue
		}

		if (strings === null) {
			strings = [...tile.strings, replacement]
			index = strings.length - 1
		}

		texts[entry] = index
	}

	return texts === null ? tile : { ...tile, texts, strings: strings ?? tile.strings }
}

// A look as the sheet prints it in black and white: no fills, automatic (black) text and lines.
export function blackAndWhite(style: SheetRenderStyle): SheetRenderStyle {
	const out: { -readonly [K in keyof SheetRenderStyle]: SheetRenderStyle[K] } = { ...style }

	delete out.fill
	delete out.pattern
	delete out.color

	for (const edge of ["top", "right", "bottom", "left", "diagonalUp", "diagonalDown"] as const) {
		const line = style[edge]

		if (line !== undefined) out[edge] = { ...line, color: 0 }
	}

	return out
}

// Where a chartsheet's chart stands on its page (points): at the top left of the area inside the margins, at its own
// size, made smaller (never stretched) where the page is smaller than the chart.
export function chartPlacement(sheet: PrintJobSheet, chart: PrintChart): { x: number; y: number; width: number; height: number } {
	const { area } = sheet.pagination
	const width = chart.width / 12_700
	const height = chart.height / 12_700
	const fit = Math.min(1, area.width / Math.max(1, width), area.height / Math.max(1, height))

	return { x: area.x, y: area.y, width: width * fit, height: height * fit }
}
