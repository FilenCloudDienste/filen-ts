import { grayRgba, paintDrawingPdf, pictureKey, pictureSource, type PdfDrawingData } from "../../../core/drawingml/pdf"
import type { DrawingImage } from "../../../core/drawingml/displayList"
import type { Matrix } from "../../../core/pdfwrite/content"
import type { PdfDeflate } from "../../../core/pdfwrite/deflate"
import type { PdfFontAssets } from "../../../core/pdfwrite/fonts/assets"
import { PdfFontSet, type PdfFontFaceRequest, type PdfShapedText } from "../../../core/pdfwrite/fonts/fontSet"
import type { PdfImageDecoder } from "../../../core/pdfwrite/images"
import type { PdfImage, PdfPage } from "../../../core/pdfwrite/page"
import { preparePassword } from "../../../core/pdfwrite/crypto"
import { PdfWriteError } from "../../../core/pdfwrite/errors"
import { PdfWriter, type PdfAbortSignal, type PdfOutput } from "../../../core/pdfwrite/writer"
import { parseHeaderFooter, type HeaderFooterStyle, type HeaderFooterValues } from "../../../core/sheet/print/headerFooter"
import { MAX_PRINT_PAGES, type PrintPage } from "../../../core/sheet/print/paginate"
import type { SheetHeaderImage, SheetPrintNote } from "../../../core/sheet/print/xlsx"
import {
	CellFlag,
	TILE_COLS,
	TILE_ROWS,
	type SheetAbortSignal,
	type SheetFileKind,
	type SheetId,
	type SheetRenderStyle,
	type SheetSessionApi,
	type SheetSummary,
	type SheetTile
} from "../../../core/sheet/protocol"
import type { Slicing } from "../../../core/slicing"
import type { SheetDrawingObject } from "../../../core/xlsx/drawings/feature"
// The query names these modules declare (print.tiles, link.get): types only, nothing of theirs runs from here.
import type {} from "../../../core/sheet/session"
import type {} from "../../../core/xlsx/hyperlinks/feature"
import { anchorBox, type SheetBox } from "../drawings/geometry"
import { SheetGridModel } from "../model"
import { DEFAULT_POINTS, textFont } from "../paint/text"
import { entryInput, entryRuns, entryText } from "../tiles"
import type { AxisView, GridView } from "../view"
import { PdfCanvas, PdfShapeCache, canvasFont, canvasText } from "./pdfCanvas"
import {
	LIST_FONT_PT,
	LIST_LINE_PT,
	NOTE_FONT,
	NOTE_FONT_PX,
	NOTE_LINE_PX,
	blackAndWhite,
	chartPlacement,
	layOutPrint,
	MAX_PAGE_CELLS,
	pageCount,
	printedTile,
	printPageAt,
	PrintPageTooLarge,
	wrap,
	type NotesPage,
	type PrintJob,
	type PrintChart,
	type PrintJobSheet,
	type PrintSheetRequest
} from "./printLayout"
import { POINTS_PER_PX, PRINT_THEME, bandLayout, pageTiles, pageView, paintPrintedCells } from "./printPage"
import { planSlices, slicePage, SliceTiles, sliceView, smallPage, surveyPage, type PageSurvey } from "./printSlices"
import { noteBox, wholeAxes } from "./printRanges"

// A print as a PDF, made where the session runs (the sheet worker): the pages the print dialog would print, cut by the
// same pagination and drawn by the grid's own painters onto PdfCanvas, the sheet's objects and charts from their
// display lists, notes, headings, headers and footers with their pictures. Tagged (PDF/UA-1): each page's cells are a
// table (header cells where print titles or a table's header row say so, hyperlinks as Link elements around their
// annotations), objects are figures with their alternative text, everything else an artifact; one outline item per
// sheet. Encrypted (AES-256) with the workbook's own password when it had one.
//
// Tiles come through print.tiles, which holds nothing for the page's grid; the pages' models never release anything.

export interface SheetPdfRequest {
	readonly sheets: readonly PrintSheetRequest[]
	// The file's name and path (&F, &Z) and the date and time (&D, &T) as the app formats them.
	readonly values: Omit<HeaderFooterValues, "page" | "pages" | "sheet">
	readonly title: string
	// BCP 47.
	readonly lang?: string
	// What the page's grid shows: the workbook's kind, its sheets and whether formulas show instead of values.
	readonly kind: SheetFileKind
	readonly summaries: readonly SheetSummary[]
	readonly date1904: boolean
	readonly showFormulas: boolean
}

export interface SheetPdfEnvironment {
	readonly session: SheetSessionApi
	readonly assets: PdfFontAssets
	// The workbook's password, when it opened with one: the PDF is encrypted with it.
	readonly password?: string
	readonly signal?: PdfAbortSignal & SheetAbortSignal
	readonly slicing?: Slicing
	readonly progress?: (done: number, total: number) => void
	readonly deterministic?: boolean
	readonly deflate?: PdfDeflate | null
	readonly decoder?: PdfImageDecoder
}

export type SheetPdfRefusal =
	// No page prints (empty sheets, a chart sheet).
	| "nothing"
	// More pages than a print lays out (MAX_PRINT_PAGES).
	| "tooManyPages"
	// A page holding more cells than a page is drawn with (MAX_PAGE_CELLS, printLayout.ts); `pages` is its number.
	| "pageTooLarge"
	// The workbook's password is one the PDF standard security handler cannot take (SASLprep prohibits it).
	| "passwordUnsupported"

export type SheetPdfResult =
	| {
			readonly ok: true
			readonly output: PdfOutput
			readonly pages: number
			// Pictures that could not be embedded (a format no decoder here reads), drawn as placeholders.
			readonly missingImages: number
			// Characters no font has, by script: drawn as missing glyphs.
			readonly missingGlyphs: number
			// Runs drawn without their font's layout tables: shaping them went past the shaper's limits.
			readonly unshapedRuns: number
	  }
	| { readonly ok: false; readonly reason: SheetPdfRefusal; readonly pages?: number }

const PX_PER_POINT = 4 / 3

// Whether the standard security handler takes the password (SASLprep, ISO 32000-2 §7.6.4.3.3).
function passwordAccepted(password: string): boolean {
	try {
		preparePassword(password)

		return true
	} catch (error) {
		if (error instanceof PdfWriteError && error.reason === "password") return false

		throw error
	}
}
// What the headings show: column letters and row numbers.
const HEADING_TEXT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
// The em box faces without metrics of their own are placed by (as SVG's text-before-edge and text-after-edge).
const ASCENT = 0.8
const DESCENT = 0.2
const NOTE_FILL = 0xffffe1ff
const BLACK = 0x000000ff

function defaultFace(family: string, bold: boolean = false, italic: boolean = false): PdfFontFaceRequest {
	return { family, bold, italic, slot: "hAnsi" }
}

// A family named in the file, else the sheet's own (its default style's), else Calibri.
function familyOf(name: string | null | undefined, fallback: string): string {
	return name !== null && name !== undefined && name !== "" ? name : fallback
}

// A cell's key in a page's maps.
function cellKey(row: number, col: number): number {
	return row * 16_384 + col
}

// Cells one slice of a large page draws (printSlices.ts).
const PDF_SLICE_CELLS = 32_768

// A large page's table, written a slice at a time: its node once a slice has text, and the columns every row has
// (those of any cell the page's tiles hold, so that rows stay regular before every slice is drawn).
interface SlicedTable {
	node: number | null
	readonly columns: readonly number[]
}

function within(span: { readonly first: number; readonly last: number } | null, index: number): boolean {
	return span !== null && index >= span.first && index <= span.last
}

// Reading order: print title rows (or columns) first.
function titlesFirst(titles: { readonly first: number; readonly last: number } | null): (a: number, b: number) => number {
	return (a, b) => (within(titles, a) ? 0 : 1) - (within(titles, b) ? 0 : 1) || a - b
}

class SheetPdfExport {
	private readonly fonts: PdfFontSet
	private readonly shapes: PdfShapeCache
	private readonly styles: SheetRenderStyle[] = [{}]
	private grayStyles: SheetRenderStyle[] | null = null
	private readonly drawn = new Map<string, Promise<PdfDrawingData | null>>()
	private readonly images = new Map<string, Promise<PdfImage | undefined>>()
	private missingImages = 0
	private writer: PdfWriter | null = null

	private readonly request: SheetPdfRequest
	private readonly environment: SheetPdfEnvironment

	constructor(request: SheetPdfRequest, environment: SheetPdfEnvironment) {
		this.request = request
		this.environment = environment
		this.fonts = new PdfFontSet({
			assets: environment.assets,
			deterministic: environment.deterministic === true,
			...(environment.signal !== undefined && { signal: environment.signal })
		})
		this.shapes = new PdfShapeCache(this.fonts)
	}

	private get session(): SheetSessionApi {
		return this.environment.session
	}

	private get signal(): SheetAbortSignal | undefined {
		return this.environment.signal
	}

	private aborted(): void {
		if (this.signal?.aborted === true) throw Object.assign(new Error("The PDF export was aborted"), { name: "AbortError" })
	}

	// A text measure for what the print lays out itself (the notes it lists): the export's own faces, loaded first.
	private measurer: PdfCanvas | null = null

	private measure = (font: string, text: string): number => {
		this.measurer ??= new PdfCanvas({ page: null, shapes: this.shapes, base: [1, 0, 0, 1, 0, 0], gray: false, tagged: false })
		this.measurer.font = font

		return this.measurer.measureText(text).width
	}

	async run(): Promise<SheetPdfResult> {
		const { request, environment } = this
		const first = request.sheets[0]

		if (first === undefined) return { ok: false, reason: "nothing" }

		// A password the PDF cannot take is refused before anything is laid out.
		if (environment.password !== undefined && !passwordAccepted(environment.password))
			return { ok: false, reason: "passwordUnsupported" }

		const activeLayout = await this.session.layout(first.sheet)
		const base = new SheetGridModel({
			session: this.session,
			info: {
				kind: request.kind,
				sheets: request.summaries,
				activeSheet: first.sheet,
				activeLayout,
				styles: { from: 0, styles: [] },
				writability: { state: "unproven" },
				state: { version: 0, dirty: false, canUndo: false, canRedo: false },
				date1904: request.date1904,
				protection: null,
				fileSharing: null
			}
		})
		let job: PrintJob | null = null

		try {
			// The faces the notes list measures with, loaded before it is laid out.
			await this.load("Cell: Note:", defaultFace("Calibri"))
			await this.load("Cell: Note:", defaultFace("Calibri", true))

			job = await layOutPrint(base, request.sheets, this.measure, MAX_PRINT_PAGES)
			this.job = job

			if (job.more) return { ok: false, reason: "tooManyPages", pages: pageCount(job) }

			const total = pageCount(job)

			if (total === 0) return { ok: false, reason: "nothing" }

			const writer = await PdfWriter.create({
				title: request.title,
				...(request.lang !== undefined && { lang: request.lang }),
				tagged: true,
				deterministic: environment.deterministic === true,
				...(environment.password !== undefined && { password: environment.password }),
				...(environment.signal !== undefined && { signal: environment.signal }),
				...(environment.slicing !== undefined && { slicing: environment.slicing }),
				...(environment.deflate !== undefined && { deflate: environment.deflate }),
				...(environment.decoder !== undefined && { decoder: environment.decoder })
			})

			this.writer = writer

			let section: number | null = null

			for (let index = 0; index < total; index++) {
				this.aborted()

				const found = printPageAt(job, index)

				if (found === null) break

				if (found.first) {
					if (section !== null) writer.close(section)

					section = writer.open("Sect", { title: found.sheet.name })
					writer.outline(found.sheet.name, 1, { page: index })
				}

				try {
					await this.page(found, total, index)
				} catch (error) {
					if (error instanceof PrintPageTooLarge) return { ok: false, reason: "pageTooLarge", pages: error.page }

					throw error
				}

				environment.progress?.(index + 1, total)
			}

			if (section !== null) writer.close(section)

			const output = await writer.finish()
			let missingGlyphs = 0

			for (const count of this.fonts.missing().values()) missingGlyphs += count

			return { ok: true, output, pages: total, missingImages: this.missingImages, missingGlyphs, unshapedRuns: this.fonts.unshaped() }
		} finally {
			job?.dispose()
			base.dispose()
			this.fonts.close()
			this.drawn.clear()
			this.images.clear()
		}
	}

	private async load(text: string, request: PdfFontFaceRequest): Promise<void> {
		const pending = this.fonts.prepare(text, 0, text.length, request)

		if (pending !== undefined) await pending
	}

	private color(color: number, gray: boolean): number {
		return gray ? grayRgba(color) : color
	}

	// --- One page ---

	private async page(found: NonNullable<ReturnType<typeof printPageAt>>, total: number, index: number): Promise<void> {
		const writer = this.writer as PdfWriter
		const sheet = found.sheet
		const { paper, area } = sheet.pagination
		const gray = sheet.setup.blackAndWhite
		const page = writer.beginPage(paper.width / POINTS_PER_PX, paper.height / POINTS_PER_PX)

		// What prints inside the margins is clipped to them.
		page.saveState()
		page.rect(area.x / POINTS_PER_PX, area.y / POINTS_PER_PX, area.width / POINTS_PER_PX, area.height / POINTS_PER_PX).clip()

		if (sheet.chart !== null) await this.chartPage(sheet, sheet.chart, page)
		else if (found.page !== null) await this.cells(sheet, found.page, page, index)
		else if (found.notes !== null) await this.notesList(sheet, found.notes, page)

		page.restoreState()

		await this.bands(sheet, found.number, total, found.first, page, gray)
		this.shapes.clear()
		await writer.endPage(page)
	}

	// A chartsheet's page: its chart, a figure, where the print places it.
	private async chartPage(sheet: PrintJobSheet, chart: PrintChart, page: PdfPage): Promise<void> {
		const writer = this.writer as PdfWriter
		const at = chartPlacement(sheet, chart)
		const rendered = await this.session
			.query("chart.render", { part: chart.part, width: chart.width, height: chart.height })
			.catch(() => null)

		if (rendered?.kind !== "drawing" || !(rendered.drawing.width > 0 && rendered.drawing.height > 0)) return

		const data = rendered.drawing
		const box: [number, number, number, number] = [
			at.x / POINTS_PER_PX,
			at.y / POINTS_PER_PX,
			at.width / POINTS_PER_PX,
			at.height / POINTS_PER_PX
		]
		const node = writer.open("Figure", { alt: `Chart: ${sheet.name}`, bbox: box })

		page.beginContent(node)
		await paintDrawingPdf(this.drawingContext(page, sheet.setup.blackAndWhite), data, [
			box[2] / data.width,
			0,
			0,
			box[3] / data.height,
			box[0],
			box[1]
		])
		page.endContent()
		writer.close(node)
	}

	// The page's content transform: the view at 100 % (px) onto the page (px), as printPageSvg places it.
	private placement(sheet: PrintJobSheet, view: GridView): Matrix {
		const { area, scale } = sheet.pagination
		const { setup } = sheet
		const k = POINTS_PER_PX * scale
		const x = area.x + (setup.horizontalCentered ? Math.max(0, (area.width - view.width * k) / 2) : 0)
		const y = area.y + (setup.verticalCentered ? Math.max(0, (area.height - view.height * k) / 2) : 0)

		return [scale, 0, 0, scale, x / POINTS_PER_PX, y / POINTS_PER_PX]
	}

	private async tiles(sheet: SheetId, coordinates: Uint32Array): Promise<SheetTile[]> {
		const answer = await this.session.query(
			"print.tiles",
			{ sheet, coordinates, known: this.styles.length },
			this.signal === undefined ? undefined : { signal: this.signal }
		)
		const styles = answer.styles

		for (let k = 0; k < styles.styles.length; k++) this.styles[styles.from + k] = styles.styles[k] ?? {}

		if (styles.styles.length > 0) this.grayStyles = null

		return [...answer.tiles]
	}

	private pageModel(sheet: PrintJobSheet, tiles: readonly SheetTile[]): SheetGridModel {
		let styles = this.styles

		if (sheet.setup.blackAndWhite) {
			this.grayStyles ??= this.styles.map(blackAndWhite)
			styles = this.grayStyles
		}

		const model = new SheetGridModel({
			session: this.session,
			info: {
				kind: this.request.kind,
				sheets: this.request.summaries,
				activeSheet: sheet.sheet,
				activeLayout: sheet.layout,
				styles: { from: 0, styles },
				writability: { state: "unproven" },
				state: { version: 0, dirty: false, canUndo: false, canRedo: false },
				date1904: this.request.date1904,
				protection: null,
				fileSharing: null
			}
		})

		model.setShowFormulas(this.request.showFormulas)

		for (const tile of tiles) model.tiles.put(printedTile(tile, sheet.setup.errors))

		return model
	}

	private async cells(sheet: PrintJobSheet, printPage: PrintPage, page: PdfPage, index: number): Promise<void> {
		const view = pageView(sheet, printPage)
		const base = this.placement(sheet, view)
		const coordinates = pageTiles(printPage)

		if (smallPage(coordinates)) {
			const tiles = await this.tiles(sheet.sheet, Uint32Array.from(coordinates))

			this.aborted()
			await this.slice(sheet, printPage, view, base, tiles, page, null)
		} else {
			await this.slices(sheet, printPage, base, page, index)
		}

		this.aborted()
		await this.over(sheet, printPage, view, base, page)
	}

	// A large page's cells, slice by slice (printSlices.ts), in one table.
	private async slices(sheet: PrintJobSheet, printPage: PrintPage, base: Matrix, page: PdfPage, index: number): Promise<void> {
		const fetch = (coordinates: Uint32Array): Promise<SheetTile[]> => this.tiles(sheet.sheet, coordinates)
		const between = (): Promise<void> => {
			this.aborted()

			return Promise.resolve()
		}
		const survey: PageSurvey | null = await surveyPage(printPage, fetch, MAX_PAGE_CELLS, between)

		if (survey === null) throw new PrintPageTooLarge(index + 1)

		const tiles = new SliceTiles(printPage, fetch, between)
		const table: SlicedTable = { node: null, columns: [...survey.columns].sort(titlesFirst(printPage.titleCols)) }

		for (const [k, span] of planSlices(printPage, survey, sheet.layout.merges, PDF_SLICE_CELLS).entries()) {
			this.aborted()

			const slice = slicePage(printPage, span, k === 0)
			const { view, top } = sliceView(sheet, printPage, slice, k === 0)
			const placed: Matrix = [base[0], base[1], base[2], base[3], base[4], base[5] + base[3] * top]

			await this.slice(sheet, slice, view, placed, await tiles.take(slice), page, table)
			tiles.drop(slice)
		}

		if (table.node !== null) (this.writer as PdfWriter).close(table.node)
	}

	// Cells drawn from `tiles` in `view` (a page's, or a slice's of it) placed by `base`, and their table (its rows
	// added to `sliced` for a slice).
	private async slice(
		sheet: PrintJobSheet,
		printPage: PrintPage,
		view: GridView,
		base: Matrix,
		tiles: readonly SheetTile[],
		page: PdfPage,
		sliced: SlicedTable | null
	): Promise<void> {
		const model = this.pageModel(sheet, tiles)
		const gray = sheet.setup.blackAndWhite

		try {
			// The faces the page's text needs, loaded before it is drawn: its cells' texts (each in its look and its
			// rich runs' looks) and the headings, shaped up front. When that loaded nothing (the usual page, its faces
			// already in) the page draws at once; otherwise it is measured until every face its text needs is in
			// (each pass loads what the last one found), then drawn: drawing never meets a face still loading.
			for (let pass = 0, loaded = await this.prepareTexts(model, tiles, printPage, sheet.layout.merges); loaded; pass++) {
				const probe = new PdfCanvas({ page: null, shapes: this.shapes, base, gray, tagged: true })

				paintPrintedCells(probe, model, sheet, printPage, PRINT_THEME, undefined, view)

				if (probe.loads.length === 0) break
				if (pass === 8) throw new Error("The fonts a page needs did not load")

				await Promise.all(probe.loads)
				this.aborted()
			}

			this.aborted()

			const canvas = new PdfCanvas({ page, shapes: this.shapes, base, gray, tagged: true })

			paintPrintedCells(
				canvas,
				model,
				sheet,
				printPage,
				PRINT_THEME,
				(row, col) => {
					canvas.content = row < 0 ? null : cellKey(row, col)
				},
				view
			)
			canvas.flush()
			this.aborted()
			await this.table(sheet, printPage, tiles, view, base, page, canvas, sliced)
		} finally {
			model.dispose()
		}
	}

	// Shapes every text the page's tiles show in the looks it is drawn in (a cell's, its rich runs') and the headings'
	// letters and digits, loading what they need. True when something had to load.
	private async prepareTexts(
		model: SheetGridModel,
		tiles: readonly SheetTile[],
		printPage: PrintPage,
		merges: Uint32Array
	): Promise<boolean> {
		const loads: Promise<void>[] = []
		const base = model.style(0)
		const request = (style: SheetRenderStyle): PdfFontFaceRequest => canvasFont(textFont(style, base, PRINT_THEME.font, 1).css).request

		this.shapes.get(HEADING_TEXT, canvasFont(`11px ${PRINT_THEME.font}`).request, loads)

		const anchors = new Set<number>()

		for (let k = 0; k + 3 < merges.length; k += 4) {
			const first = merges[k] ?? 0
			const last = merges[k + 2] ?? 0

			for (const span of [printPage.rows, printPage.titleRows])
				if (span !== null && first < span.first && last >= span.first) anchors.add(first)
		}

		for (const tile of tiles) {
			for (let entry = 0; entry < tile.count; entry++) {
				const position = tile.positions[entry] ?? 0
				const row = tile.tileRow * TILE_ROWS + (position >>> 5)

				// The page's own rows (a tile reaches past them), every column of them (a text running on from a cell
				// beside the page is drawn on it), and the first rows of merged cells reaching into the page.
				if (!within(printPage.rows, row) && !within(printPage.titleRows, row) && !anchors.has(row)) continue

				const text = this.request.showFormulas ? entryInput(tile, entry) : entryText(tile, entry)

				if (text === "") continue

				const style = model.style(tile.styles[entry] ?? 0)

				this.shapes.get(canvasText(text), request(style), loads)

				const runs = ((tile.flags[entry] ?? 0) & CellFlag.RICH) === 0 ? null : entryRuns(tile, entry)

				for (let k = 1; runs !== null && k < runs.length; k += 2)
					this.shapes.get(canvasText(text), request({ ...style, ...model.style(runs[k] ?? 0) }), loads)
			}
		}

		if (loads.length === 0) return false

		await Promise.all(loads)

		return true
	}

	// --- Structure: the page's cells as a table ---

	// The text the page's cells drew, as its Table: a row per row with text and a cell per cell with text, in reading
	// order (print title rows and columns first); header cells (TH) in print title rows and columns and in a filter's
	// or table's header row. A hyperlinked cell holds a Link element: its text and its annotation.
	private async table(
		sheet: PrintJobSheet,
		printPage: PrintPage,
		tiles: readonly SheetTile[],
		view: GridView,
		base: Matrix,
		page: PdfPage,
		canvas: PdfCanvas,
		sliced: SlicedTable | null
	): Promise<void> {
		const writer = this.writer as PdfWriter
		const cells = canvas.keptCells()

		if (cells.size === 0) return

		const linked = new Set<number>()

		for (const tile of tiles) {
			for (let entry = 0; entry < tile.count; entry++) {
				if (((tile.flags[entry] ?? 0) & CellFlag.HYPERLINK) === 0) continue

				const position = tile.positions[entry] ?? 0

				linked.add(cellKey(tile.tileRow * TILE_ROWS + (position >>> 5), tile.tileCol * TILE_COLS + (position & 31)))
			}
		}

		const headerRows = new Map<number, { readonly first: number; readonly last: number }[]>()

		for (const filter of sheet.layout.extensions?.filters?.ranges ?? []) {
			const list = headerRows.get(filter.range.startRow) ?? []

			list.push({ first: filter.range.startCol, last: filter.range.endCol })
			headerRows.set(filter.range.startRow, list)
		}

		const byRow = new Map<number, number[]>()

		for (const key of cells) {
			const row = Math.floor(key / 16_384)
			const list = byRow.get(row) ?? []

			list.push(key % 16_384)
			byRow.set(row, list)
		}

		// Rows are regular (ISO 14289-1 §7.2: every row as many columns): the columns any row has text in (a large
		// page's slices: any its tiles have a cell in), a row's columns without text one empty cell spanning them.
		const columns = sliced?.columns ?? [...new Set([...byRow.values()].flat())].sort(titlesFirst(printPage.titleCols))

		if (sliced !== null) sliced.node ??= writer.open("Table")

		const table = sliced?.node ?? writer.open("Table")

		for (const row of [...byRow.keys()].sort(titlesFirst(printPage.titleRows))) {
			const tr = writer.open("TR")
			const own = new Set(byRow.get(row))
			let empty = 0
			const gap = (): void => {
				if (empty === 0) return

				writer.close(writer.open("TD", empty > 1 ? { colSpan: empty } : undefined))
				empty = 0
			}

			for (const col of columns) {
				if (!own.has(col)) {
					empty++
					continue
				}

				gap()

				const titleRow =
					within(printPage.titleRows, row) || (headerRows.get(row)?.some(span => col >= span.first && col <= span.last) ?? false)
				const titleCol = within(printPage.titleCols, col)
				const header = titleRow || titleCol
				const cell = writer.open(
					header ? "TH" : "TD",
					header ? { scope: titleRow && titleCol ? "Both" : titleRow ? "Column" : "Row" } : undefined
				)
				const key = cellKey(row, col)

				if (linked.has(key)) {
					const link = writer.open("Link")

					canvas.drawCell(key, link)
					await this.link(sheet, row, col, view, base, page, link)
					writer.close(link)
				} else {
					canvas.drawCell(key, cell)
				}

				writer.close(cell)
			}

			gap()
			writer.close(tr)
		}

		if (sliced === null) writer.close(table)
	}

	// A cell's box on the page (px), from the page's view.
	private cellBox(sheet: PrintJobSheet, view: GridView, base: Matrix, row: number, col: number): [number, number, number, number] {
		const at = (axis: AxisView, index: number): number =>
			index >= axis.frozenFirst && index < axis.frozenEnd
				? axis.header + axis.axis.offset(index) - axis.axis.offset(axis.frozenFirst)
				: axis.header + axis.frozenSize + axis.axis.offset(index) - axis.axis.offset(axis.first)
		const width = view.cols.axis.size(col)
		let x = at(view.cols, col)

		if (sheet.layout.rightToLeft) x = view.width - x - width

		const y = at(view.rows, row)
		const height = view.rows.axis.size(row)

		return [base[0] * x + base[4], base[3] * y + base[5], base[0] * width, base[3] * height]
	}

	// The link annotation of a hyperlinked cell: a URL through the shared link policy, a place in the workbook as the
	// page that prints it (nothing when no page does).
	private async link(
		sheet: PrintJobSheet,
		row: number,
		col: number,
		view: GridView,
		base: Matrix,
		page: PdfPage,
		node: number
	): Promise<void> {
		const link = await this.session.query("link.get", { sheet: sheet.sheet, row, col }).catch(() => null)

		if (link === null) return

		const box = this.cellBox(sheet, view, base, row, col)

		if (link.url !== null) {
			page.link(box, { uri: link.url }, { node, contents: link.tooltip ?? link.url })

			return
		}

		const place = link.place

		if (place === null) return

		const target = this.pageOf(place.sheet, place.range.startRow, place.range.startCol)

		if (target !== null) page.link(box, { page: target }, { node, contents: link.tooltip ?? link.location ?? "" })
	}

	private job: PrintJob | null = null

	// The index of the page printing a cell, or null.
	private pageOf(sheet: SheetId, row: number, col: number): number | null {
		const job = this.job

		if (job === null) return null

		let before = 0

		for (const printed of job.sheets) {
			if (printed.sheet === sheet) {
				const at = printed.pagination.pages.findIndex(
					candidate =>
						row >= candidate.rows.first &&
						row <= candidate.rows.last &&
						col >= candidate.cols.first &&
						col <= candidate.cols.last
				)

				return at < 0 ? null : before + at
			}

			before += printed.pagination.pages.length + printed.notesAtEnd.length
		}

		return null
	}

	// --- Objects and shown notes ---

	private async over(sheet: PrintJobSheet, printPage: PrintPage, view: GridView, base: Matrix, page: PdfPage): Promise<void> {
		if (sheet.objects.length === 0 && sheet.shownNotes.length === 0) return

		const axes = wholeAxes(sheet.layout, sheet.rowSizes)
		const left = axes.cols.offset(printPage.cols.first)
		const top = axes.rows.offset(printPage.rows.first)
		const right = axes.cols.offset(printPage.cols.last + 1)
		const bottom = axes.rows.offset(printPage.rows.last + 1)
		const paneX = view.cols.header + view.cols.frozenSize
		const paneY = view.rows.header + view.rows.frozenSize
		const mirrored = sheet.layout.rightToLeft
		const place = (box: SheetBox): SheetBox => {
			const x = paneX + box.x - left

			return { x: mirrored ? view.width - x - box.width : x, y: paneY + box.y - top, width: box.width, height: box.height }
		}
		const meets = (box: SheetBox): boolean => box.x < right && box.x + box.width > left && box.y < bottom && box.y + box.height > top
		const clipX = mirrored ? view.width - paneX - (right - left) : paneX
		const writer = this.writer as PdfWriter
		const gray = sheet.setup.blackAndWhite

		page.saveState()
		page.concat(base)
		page.rect(clipX, paneY, right - left, bottom - top).clip()

		for (const object of sheet.objects) {
			const box = anchorBox(object.anchor, axes)

			if (!meets(box)) continue

			const data = await this.objectData(sheet, object, box)

			if (data === null || !(data.width > 0 && data.height > 0)) continue

			const at = place(box)
			const alt = object.alt !== "" ? object.alt : object.name
			const node = writer.open("Figure", {
				alt: alt === "" ? (object.chartPart !== undefined ? "Chart" : "Picture") : alt,
				bbox: [base[0] * at.x + base[4], base[3] * at.y + base[5], base[0] * at.width, base[3] * at.height]
			})

			page.beginContent(node)
			await paintDrawingPdf(this.drawingContext(page, gray), data, [at.width / data.width, 0, 0, at.height / data.height, at.x, at.y])
			page.endContent()
			writer.close(node)
		}

		for (const note of sheet.shownNotes) {
			const box = noteBox(note, axes)

			if (meets(box)) await this.shownNote(note, place(box), page, gray)
		}

		page.restoreState()
	}

	private drawingContext(page: PdfPage, gray: boolean): Parameters<typeof paintDrawingPdf>[0] {
		return { page, fonts: this.fonts, image: image => this.image(image), defaultFamily: "Calibri", gray }
	}

	// An object's display list, once per export: a chart through chart.render at the object's size, a picture or shape
	// through drawing.render.
	private objectData(sheet: PrintJobSheet, object: SheetDrawingObject, box: SheetBox): Promise<PdfDrawingData | null> {
		const key = `${String(sheet.sheet)}:${String(object.key)}:${object.stamp}`
		let made = this.drawn.get(key)

		if (made === undefined) {
			made = (async () => {
				try {
					if (object.chartPart !== undefined) {
						const chart = await this.session.query("chart.render", {
							part: object.chartPart,
							width: Math.max(1, Math.round(box.width)) * 9525,
							height: Math.max(1, Math.round(box.height)) * 9525
						})

						return chart.kind === "drawing" ? chart.drawing : null
					}

					const rendered = await this.session.query("drawing.render", {
						sheet: sheet.sheet,
						key: object.key,
						stamp: object.stamp
					})

					return rendered?.kind === "drawing" ? rendered.drawing : null
				} catch {
					return null
				}
			})()
			this.drawn.set(key, made)
		}

		return made
	}

	// A drawing's picture embedded once per export: its own bytes (a metafile's bitmap), else its part (an SVG's raster
	// fallback); undefined where it cannot be.
	private image(image: DrawingImage): Promise<PdfImage | undefined> {
		const writer = this.writer as PdfWriter
		const partName = image.partName

		if (image.bytes !== undefined) {
			return writer.image(pictureSource(image, image.bytes, undefined)).catch(() => {
				this.missingImages++

				return undefined
			})
		}

		if (partName === undefined || image.format === "svg") return Promise.resolve(undefined)

		const key = pictureKey(image, partName)
		let made = this.images.get(key)

		if (made === undefined) {
			made = (async () => {
				try {
					const media = await this.session.query("drawing.media", { partName })

					return media === null ? undefined : await writer.image(pictureSource(image, media.bytes, partName))
				} catch {
					this.missingImages++

					return undefined
				}
			})()
			this.images.set(key, made)
		}

		return made
	}

	// Text drawn with its pen at (x, y) on the baseline, px. The width drawn.
	private async text(
		page: PdfPage,
		raw: string,
		request: PdfFontFaceRequest,
		x: number,
		y: number,
		px: number,
		color: number
	): Promise<number> {
		const text = canvasText(raw)

		if (text === "") return 0

		const shaped = await this.shaped(text, request)

		if (shaped.runs.length > 0) {
			const faux = shaped.runs[0]

			page.text(shaped.runs, {
				x,
				y,
				size: px,
				color,
				text,
				...(faux?.fauxItalic === true && { transform: [1, 0, -0.21, 1] }),
				...(faux?.fauxBold === true && { render: "fillStroke", strokeWidth: px / 30 })
			})
		}

		return (shaped.width * px) / 1000
	}

	private async width(raw: string, request: PdfFontFaceRequest, px: number): Promise<number> {
		const text = canvasText(raw)

		if (text === "") return 0

		return ((await this.shaped(text, request)).width * px) / 1000
	}

	private async shaped(text: string, request: PdfFontFaceRequest): Promise<PdfShapedText> {
		for (let pass = 0; pass <= 8; pass++) {
			const loads: Promise<void>[] = []
			const shaped = this.shapes.get(text, request, loads)

			if (shaped !== null) return shaped

			await Promise.all(loads)
		}

		throw new Error("The fonts a text needs did not load")
	}

	private async shownNote(note: SheetPrintNote, box: SheetBox, page: PdfPage, gray: boolean): Promise<void> {
		const writer = this.writer as PdfWriter
		const regular = defaultFace("Tahoma")
		const bold = defaultFace("Tahoma", true)

		await this.load(`${note.author} ${note.text}`, regular)
		await this.load(note.author, bold)

		const lines = wrap(note.author === "" ? note.text : `${note.author}:\n${note.text}`, Math.max(1, box.width - 8), text =>
			this.measure(NOTE_FONT, text)
		)
		const fitting = lines.slice(0, Math.max(1, Math.floor((box.height - 4) / NOTE_LINE_PX)))

		page.beginArtifact({ type: "Layout" })
		page.fillColor(this.color(NOTE_FILL, gray))
			.rect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1)
			.fill()
		page.strokeColor(BLACK)
			.lineWidth(1)
			.rect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1)
			.stroke()
		page.endArtifact()

		const node = writer.open("P")

		page.beginContent(node)

		for (const [k, line] of fitting.entries())
			await this.text(
				page,
				line,
				k === 0 && note.author !== "" ? bold : regular,
				box.x + 4,
				box.y + 3 + NOTE_FONT_PX + k * NOTE_LINE_PX,
				NOTE_FONT_PX,
				BLACK
			)

		page.endContent()
		writer.close(node)
	}

	// --- Notes listed at the end ---

	private async notesList(sheet: PrintJobSheet, notes: NotesPage, page: PdfPage): Promise<void> {
		const writer = this.writer as PdfWriter
		const { area } = sheet.pagination
		const family = familyOf(this.styles[0]?.font, "Calibri")

		for (const [k, line] of notes.lines.entries()) {
			if (line.text === "") continue

			const node = writer.open("P")

			page.beginContent(node)
			await this.text(
				page,
				line.text,
				defaultFace(family, line.bold),
				area.x / POINTS_PER_PX,
				(area.y + LIST_FONT_PT + k * LIST_LINE_PT) / POINTS_PER_PX,
				LIST_FONT_PT * PX_PER_POINT,
				BLACK
			)
			page.endContent()
			writer.close(node)
		}
	}

	// --- Header and footer ---

	private async bands(sheet: PrintJobSheet, number: number, pages: number, first: boolean, page: PdfPage, gray: boolean): Promise<void> {
		const { setup, pagination } = sheet
		const { headerFooter, margins } = setup
		const texts =
			first && headerFooter.differentFirst
				? headerFooter.first
				: headerFooter.differentOddEven && number % 2 === 0
					? headerFooter.even
					: headerFooter.odd
		const values: HeaderFooterValues = { ...this.request.values, sheet: sheet.name, page: number, pages }
		const family = familyOf(this.styles[0]?.font, "Calibri")
		const scale = headerFooter.scaleWithDoc ? pagination.scale : 1
		const across = { left: margins.left * 72, right: pagination.paper.width - margins.right * 72 }
		const pictures = await this.bandPictures(sheet, number, first)

		for (const header of [true, false]) {
			const sections = parseHeaderFooter(header ? texts.header : texts.footer)
			const at = header ? margins.header * 72 : pagination.paper.height - margins.footer * 72
			const laid = bandLayout(sections, values, across, at, header, scale, header ? pictures.header : pictures.footer)

			if (laid.every(section => section.lines.length === 0 && section.picture === null)) continue

			page.beginArtifact({ type: "Pagination", subtype: header ? "Header" : "Footer" })

			for (const section of laid) {
				const placed = section.picture

				if (placed !== null) await this.bandPicture(placed.picture, placed.left, placed.top, placed.scale, page, gray)

				for (const line of section.lines) {
					const pieces: { text: string; style: HeaderFooterStyle; request: PdfFontFaceRequest; px: number; width: number }[] = []
					let width = 0
					let tallest = 0

					for (const piece of line.pieces) {
						const points = (piece.style.size ?? DEFAULT_POINTS) * scale * (piece.style.script === null ? 1 : 0.65)
						const px = points * PX_PER_POINT
						const request = defaultFace(familyOf(piece.style.font, family), piece.style.bold, piece.style.italic)
						const measured = await this.width(piece.text, request, px)

						pieces.push({ text: piece.text, style: piece.style, request, px, width: measured })
						width += measured
						tallest = Math.max(tallest, px)
					}

					const x = section.x / POINTS_PER_PX - (section.anchor === "middle" ? width / 2 : section.anchor === "end" ? width : 0)
					const edge = line.y / POINTS_PER_PX
					const baseline = header ? edge + tallest * ASCENT : edge - tallest * DESCENT
					let pen = x

					for (const piece of pieces) {
						const shift =
							piece.style.script === "superscript"
								? -piece.px * 0.5
								: piece.style.script === "subscript"
									? piece.px * 0.25
									: 0
						const color = this.color(
							piece.style.color === null ? BLACK : ((piece.style.color & 0xffffff) * 256 + 255) >>> 0,
							gray
						)

						await this.text(page, piece.text, piece.request, pen, baseline + shift, piece.px, color)

						const thickness = Math.max(0.5, piece.px / 14)

						if (piece.style.underline !== null) {
							page.fillColor(color)
								.rect(pen, baseline + shift + piece.px * 0.12, piece.width, thickness)
								.fill()

							if (piece.style.underline === "double")
								page.rect(pen, baseline + shift + piece.px * 0.12 + thickness * 2, piece.width, thickness).fill()
						}

						if (piece.style.strike)
							page.fillColor(color)
								.rect(pen, baseline + shift - piece.px * 0.3, piece.width, thickness)
								.fill()

						pen += piece.width
					}
				}
			}

			page.endArtifact()
		}
	}

	private async bandPictures(
		sheet: PrintJobSheet,
		number: number,
		first: boolean
	): Promise<{
		header: Partial<Record<"left" | "center" | "right", SheetHeaderImage>>
		footer: Partial<Record<"left" | "center" | "right", SheetHeaderImage>>
	}> {
		const header: Partial<Record<"left" | "center" | "right", SheetHeaderImage>> = {}
		const footer: Partial<Record<"left" | "center" | "right", SheetHeaderImage>> = {}
		const { headerFooter } = sheet.setup
		const variant = first && headerFooter.differentFirst ? "FIRST" : headerFooter.differentOddEven && number % 2 === 0 ? "EVEN" : ""
		const sections: Readonly<Record<string, "left" | "center" | "right">> = { L: "left", C: "center", R: "right" }

		for (const image of sheet.headerImages) {
			const section = sections[image.position[0] ?? ""]

			if (section === undefined || image.position.slice(2) !== variant) continue

			;(image.position[1] === "H" ? header : footer)[section] = image
		}

		return { header, footer }
	}

	// A header or footer picture at (left, top) in points, at its own size times `scale`.
	private async bandPicture(
		image: SheetHeaderImage,
		left: number,
		top: number,
		scale: number,
		page: PdfPage,
		gray: boolean
	): Promise<void> {
		const x = left / POINTS_PER_PX
		const y = top / POINTS_PER_PX
		const width = (image.width * scale) / POINTS_PER_PX
		const height = (image.height * scale) / POINTS_PER_PX

		if (!(width > 0 && height > 0)) return

		if (image.image.kind === "drawing") {
			const data = image.image.drawing

			if (data.width > 0 && data.height > 0)
				await paintDrawingPdf(this.drawingContext(page, gray), data, [width / data.width, 0, 0, height / data.height, x, y])

			return
		}

		const picture = await this.image({
			partName: image.image.partName,
			format: "unknown",
			handling: "native",
			svgPartName: undefined,
			crop: { left: 0, top: 0, right: 0, bottom: 0 },
			alpha: 1,
			grayscale: false,
			biLevel: -1,
			duotone: null,
			brightness: 0,
			contrast: 0,
			colorChange: null
		})

		if (picture !== undefined) page.drawImage(picture, x, y, width, height)
	}
}

// The print as a PDF. Throws an AbortError when the signal aborts; refuses an empty print and one past the page cap.
export async function exportSheetPdf(request: SheetPdfRequest, environment: SheetPdfEnvironment): Promise<SheetPdfResult> {
	return await new SheetPdfExport(request, environment).run()
}
