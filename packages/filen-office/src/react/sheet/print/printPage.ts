import {
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	tileColOf,
	tileRowOf,
	type SheetAxisLayout,
	type SheetId,
	type SheetLayout,
	type SheetRange
} from "../../../core/sheet/protocol"
import { columnName } from "../../../core/sheet/refs/cellRef"
import {
	parseHeaderFooter,
	runText,
	type HeaderFooterRun,
	type HeaderFooterSections,
	type HeaderFooterStyle,
	type HeaderFooterValues
} from "../../../core/sheet/print/headerFooter"
import { paginate, type PrintPage, type SheetPagination } from "../../../core/sheet/print/paginate"
import type { SheetHeaderFooter, SheetHeaderFooterTexts, SheetPageSetup, SheetPrintSpan } from "../../../core/sheet/print/setup"
import type { SheetPrintRows } from "../../../core/sheet/print/xlsx"
import { createGridAxis, shownIndex, shownIndices, type GridAxis } from "../axis"
import { decoratePane, decoratorInset, paintScene, type SheetCellDecorator } from "../layers"
import type { SheetGridModel } from "../model"
import { CF_BAR_DECORATOR, CF_ICON_DECORATOR } from "../overlays/cf"
import { BorderPainter } from "../paint/borders"
import { rgb, type GridCanvas } from "../paint/canvas"
import { paintCells } from "../paint/cells"
import { PatternCache } from "../paint/patterns"
import { DEFAULT_POINTS, TextMeasurer, fontFamily } from "../paint/text"
import { DEFAULT_THEME, type SheetGridTheme } from "../theme"
import type { AxisView, GridView } from "../view"
import { escapeSvgText, SvgCanvas } from "./svgCanvas"

// One printed page as SVG: the page's cells (and the title rows and columns repeated on it) drawn by the grid's own
// painters at 100 % and scaled onto the paper inside the margins, the headings when the sheet prints them, and the
// header and footer. Cells come from the tiles the grid model holds (printTiles.ts asks for them first); conditional
// formatting's bars and icons print, the grid's selection, notes' marks and filter buttons do not, as in Excel.

// CSS pixels at 100 % to points.
export const POINTS_PER_PX = 0.75

// What a printed page looks like where the file says nothing: paper white, black text, grey gridlines.
export const PRINT_THEME: SheetGridTheme = {
	...DEFAULT_THEME,
	background: "#ffffff",
	text: "#000000",
	gridLine: "#a6a6a6",
	border: "#000000",
	headerBackground: "#ffffff",
	headerText: "#000000",
	headerLine: "#a6a6a6"
}

const PRINTED_DECORATORS: readonly SheetCellDecorator[] = [CF_BAR_DECORATOR, CF_ICON_DECORATOR]
// The headings' band at 100 %: column letters a default row high, row numbers as wide as pagination made them.
const HEADING_FONT_PX = 11

export interface PrintedSheet {
	readonly sheet: SheetId
	readonly name: string
	readonly layout: SheetLayout
	// The rows' sizes the pages were cut by (the file's heights, else the layout's).
	readonly rowSizes: SheetAxisLayout
	readonly setup: SheetPageSetup
	readonly pagination: SheetPagination
	// The axes at 100 % the pages were cut from (pixels).
	readonly rows: GridAxis
	readonly cols: GridAxis
}

// Ranges reaching the grid's end (whole rows or columns) print only as far as `used` goes, as Excel prints them.
export function clampRanges(ranges: readonly SheetRange[], used: SheetRange | null): SheetRange[] {
	const out: SheetRange[] = []

	for (const range of ranges) {
		const endRow = range.endRow >= SHEET_MAX_ROWS - 1 ? Math.min(range.endRow, used?.endRow ?? -1) : range.endRow
		const endCol = range.endCol >= SHEET_MAX_COLS - 1 ? Math.min(range.endCol, used?.endCol ?? -1) : range.endCol

		if (endRow >= range.startRow && endCol >= range.startCol) out.push({ ...range, endRow, endCol })
	}

	return out
}

// Sizes are kept to 1/12 px: a height the file stores in points (print.rows) is not rounded back to whole pixels.
const FINE = 12

// An axis of a printed sheet at 100 %, in pixels kept fractional.
export function printAxis(layout: SheetAxisLayout, count: number): GridAxis {
	const fine = createGridAxis(layout, count, FINE)

	return {
		count: fine.count,
		total: fine.total / FINE,
		defaultSize: fine.defaultSize / FINE,
		size: index => fine.size(index) / FINE,
		offset: index => fine.offset(index) / FINE,
		indexAt: position => fine.indexAt(position * FINE),
		hidden: index => fine.hidden(index),
		lastShown: fine.lastShown,
		nextShown: (index, direction) => shownIndex(fine, index, direction)
	}
}

// A sheet cut into pages: `ranges` (already clamped) on the sheet's own axes at 100 %.
export function printSheet(
	sheet: SheetId,
	name: string,
	layout: SheetLayout,
	setup: SheetPageSetup,
	ranges: readonly SheetRange[],
	// The pages laid out at most (the pagination says when more would follow).
	maxPages?: number,
	// The rows at the heights the file stores (print.rows); the layout's whole pixels without them.
	exact?: SheetPrintRows | null
): PrintedSheet {
	const rowSizes = exact ?? layout.rows
	let rowCount = 1
	let colCount = 1

	for (const range of ranges) {
		rowCount = Math.max(rowCount, range.endRow + 1)
		colCount = Math.max(colCount, range.endCol + 1)
	}

	if (setup.titleRows !== null) rowCount = Math.max(rowCount, setup.titleRows.last + 1)
	if (setup.titleCols !== null) colCount = Math.max(colCount, setup.titleCols.last + 1)

	const rows = printAxis(rowSizes, Math.min(SHEET_MAX_ROWS, rowCount))
	const cols = printAxis(layout.cols, Math.min(SHEET_MAX_COLS, colCount))
	const pagination = paginate(
		{
			setup,
			ranges,
			rows: { count: rows.count, size: index => rows.size(index) * POINTS_PER_PX },
			cols: { count: cols.count, size: index => cols.size(index) * POINTS_PER_PX }
		},
		maxPages
	)

	return { sheet, name, layout, rowSizes, setup, pagination, rows, cols }
}

// The tiles a page draws: tile row and column pairs.
export function pageTiles(page: PrintPage): number[] {
	const out: number[] = []
	const rowSpans: SheetPrintSpan[] = page.titleRows === null ? [page.rows] : [page.titleRows, page.rows]
	const colSpans: SheetPrintSpan[] = page.titleCols === null ? [page.cols] : [page.titleCols, page.cols]
	const seen = new Set<number>()

	for (const rows of rowSpans) {
		for (const cols of colSpans) {
			for (let tileRow = tileRowOf(rows.first); tileRow <= tileRowOf(rows.last); tileRow++) {
				for (let tileCol = tileColOf(cols.first); tileCol <= tileColOf(cols.last); tileCol++) {
					const key = tileRow * 1024 + tileCol

					if (seen.has(key)) continue

					seen.add(key)
					out.push(tileRow, tileCol)
				}
			}
		}
	}

	return out
}

function axisView(axis: GridAxis, header: number, titles: SheetPrintSpan | null, span: SheetPrintSpan): AxisView {
	const frozenFirst = titles?.first ?? 0
	const frozenEnd = titles === null ? 0 : titles.last + 1
	const bodyStart = axis.offset(frozenEnd)
	const frozenSize = bodyStart - axis.offset(frozenFirst)
	const bodyView = axis.offset(span.last + 1) - axis.offset(span.first)

	return {
		axis,
		header,
		frozen: frozenEnd - frozenFirst,
		frozenFirst,
		frozenEnd,
		frozenSize,
		bodyStart,
		scroll: axis.offset(span.first) - bodyStart,
		view: header + frozenSize + bodyView,
		bodyView,
		first: span.first,
		last: span.last
	}
}

export function pageView(printed: PrintedSheet, page: PrintPage): GridView {
	const { pagination } = printed
	const rows = axisView(printed.rows, pagination.headingHeight / POINTS_PER_PX, page.titleRows, page.rows)
	const cols = axisView(printed.cols, pagination.headingWidth / POINTS_PER_PX, page.titleCols, page.cols)

	return { rows, cols, width: cols.view, height: rows.view }
}

// The row numbers and column letters, in their bands, over the indices each segment shows.
function paintHeadings(canvas: GridCanvas, view: GridView, theme: SheetGridTheme, mirrored: boolean): void {
	const left = (x: number, width: number): number => (mirrored ? view.width - x - width : x)
	const cell = (x: number, y: number, width: number, height: number, label: string): void => {
		canvas.fillStyle = theme.headerBackground
		canvas.fillRect(left(x, width), y, width, height)
		canvas.strokeStyle = theme.headerLine
		canvas.lineWidth = 1
		canvas.beginPath()
		canvas.rect(left(x, width) + 0.5, y + 0.5, width - 1, height - 1)
		canvas.stroke()
		canvas.fillStyle = theme.headerText
		canvas.fillText(label, left(x, width) + width / 2, y + height / 2)
	}

	canvas.setTransform(1, 0, 0, 1, 0, 0)
	canvas.font = `${String(HEADING_FONT_PX)}px ${theme.font}`
	canvas.textAlign = "center"
	canvas.textBaseline = "middle"

	const walk = (axis: AxisView, draw: (index: number, start: number, size: number) => void): void => {
		const spans: [number, number, number][] = []

		if (axis.frozen > 0) spans.push([axis.frozenFirst, axis.frozenEnd - 1, axis.header])
		if (axis.last >= axis.first) spans.push([axis.first, axis.last, axis.header + axis.frozenSize])

		for (const [first, last, start] of spans) {
			const origin = axis.axis.offset(first)

			for (const index of shownIndices(axis.axis, first, last))
				draw(index, start + axis.axis.offset(index) - origin, axis.axis.size(index))
		}
	}

	if (view.cols.header > 0) {
		// A slice below a page's first has no column letters of its own (printSlices.ts).
		const letters = view.rows.header > 0

		if (letters) cell(0, 0, view.cols.header, view.rows.header, "")

		walk(view.rows, (row, y, height) => cell(0, y, view.cols.header, height, String(row + 1)))

		if (letters) walk(view.cols, (col, x, width) => cell(x, 0, width, view.rows.header, columnName(col)))
	}
}

export interface PrintPageOptions {
	readonly model: SheetGridModel
	readonly printed: PrintedSheet
	readonly page: PrintPage
	// Unique among the pages of one print (the SVGs share a document's ids).
	readonly id: string
	// The page's number and the print's page count, as &P and &N print them.
	readonly number: number
	readonly pages: number
	readonly values: Omit<HeaderFooterValues, "page" | "pages">
	// Whether it is the sheet's first page, and the print's nth page (odd and even headers alternate on it).
	readonly first: boolean
	readonly measure: (font: string, text: string) => number
	readonly theme?: SheetGridTheme
	// Drawn over the cells in the page's coordinates (px at 100 %): objects and shown notes, each clipped by its caller.
	readonly over?: string
	readonly pictures?: { readonly header: BandPictures; readonly footer: BandPictures }
}

function number(value: number): string {
	return String(Math.round(value * 100) / 100)
}

function tspan(text: string, style: HeaderFooterStyle, base: string, size: number, scale: number): string {
	if (text === "") return ""

	const points = (style.size ?? size) * scale
	const decorations = [style.underline !== null ? "underline" : "", style.strike ? "line-through" : ""].filter(part => part !== "")
	const attributes =
		` font-family="${escapeSvgText(fontFamily(style.font ?? undefined, base))}" font-size="${number(points * (style.script === null ? 1 : 0.65))}"` +
		(style.bold ? ' font-weight="bold"' : "") +
		(style.italic ? ' font-style="italic"' : "") +
		(decorations.length === 0 ? "" : ` text-decoration="${decorations.join(" ")}"`) +
		(style.script === "superscript" ? ' baseline-shift="super"' : style.script === "subscript" ? ' baseline-shift="sub"' : "") +
		(style.color === null ? "" : ` fill="${rgb(style.color)}"`)

	return `<tspan${attributes}>${escapeSvgText(text)}</tspan>`
}

// One band (a header or a footer) of three sections, each line of each section a text element.
// A header or footer picture as drawn in a band: its markup at its own size (points) from its top left.
export interface BandPicture {
	readonly markup: string
	readonly width: number
	readonly height: number
}

export type BandSide = "left" | "center" | "right"

export type BandPictures = Partial<Record<BandSide, BandPicture>>

const BAND_SIDES: Readonly<Record<string, BandSide>> = { L: "left", C: "center", R: "right" }

// The header and footer texts a page prints: the first page's when the sheet has its own, an even page number's when
// it has its own (by the number printed, whatever the first page number), else the odd pages'. `pictures` is the
// suffix of the header and footer pictures that go with them (shape ids LH, CF, RHFIRST, …).
export function bandVariant(
	headerFooter: SheetHeaderFooter,
	number: number,
	first: boolean
): { readonly texts: SheetHeaderFooterTexts; readonly pictures: "FIRST" | "EVEN" | "" } {
	if (first && headerFooter.differentFirst) return { texts: headerFooter.first, pictures: "FIRST" }
	if (headerFooter.differentOddEven && number % 2 === 0) return { texts: headerFooter.even, pictures: "EVEN" }

	return { texts: headerFooter.odd, pictures: "" }
}

// Where a header or footer picture shows, by its position (section letter, H or F, then its set's suffix): null when
// it is not of the page's set (bandVariant's `pictures`).
export function bandPictureSlot(position: string, pictures: string): { readonly header: boolean; readonly side: BandSide } | null {
	const side = BAND_SIDES[position[0] ?? ""]

	if (side === undefined || position.slice(2) !== pictures) return null

	return { header: position[1] === "H", side }
}

// Where a page's content (its view at 100 %, px) stands on the paper: its top left corner and its scale (points per
// px), centred inside the margins where the setup says.
export function pagePlacement(printed: PrintedSheet, view: GridView): { readonly x: number; readonly y: number; readonly k: number } {
	const { setup, pagination } = printed
	const { area, scale } = pagination
	const k = POINTS_PER_PX * scale
	const x = area.x + (setup.horizontalCentered ? Math.max(0, (area.width - view.width * k) / 2) : 0)
	const y = area.y + (setup.verticalCentered ? Math.max(0, (area.height - view.height * k) / 2) : 0)

	return { x, y, k }
}

// One section's place in a band (a header or a footer): its anchor, its picture's box and its lines of text, each
// line's pieces in their looks (fields joined with the text around them when they share its look). Points; `y` is
// the line's top edge in a header and its bottom edge in a footer.
export interface BandSection<P> {
	readonly x: number
	readonly anchor: "start" | "middle" | "end"
	readonly picture: { readonly left: number; readonly top: number; readonly scale: number; readonly picture: P } | null
	readonly lines: readonly {
		readonly y: number
		readonly pieces: readonly { readonly text: string; readonly style: HeaderFooterStyle }[]
	}[]
}

export function bandLayout<P extends { readonly width: number; readonly height: number }>(
	sections: HeaderFooterSections,
	values: HeaderFooterValues,
	area: { readonly left: number; readonly right: number },
	at: number,
	header: boolean,
	scale: number,
	pictures: Partial<Record<"left" | "center" | "right", P>>
): BandSection<P>[] {
	const out: BandSection<P>[] = []
	const place: readonly ["left" | "center" | "right", number, BandSection<P>["anchor"]][] = [
		["left", area.left, "start"],
		["center", (area.left + area.right) / 2, "middle"],
		["right", area.right, "end"]
	]

	for (const [section, x, anchor] of place) {
		// Lines split at line breaks the text holds.
		const lines: HeaderFooterRun[][] = [[]]

		for (const run of sections[section]) {
			if (run.kind !== "text" || !run.text.includes("\n")) {
				lines[lines.length - 1]?.push(run)

				continue
			}

			run.text.split(/\r?\n/).forEach((part, k) => {
				if (k > 0) lines.push([])
				if (part !== "") lines[lines.length - 1]?.push({ ...run, text: part })
			})
		}

		const lineHeight = DEFAULT_POINTS * 1.2 * scale
		const ordered = header ? lines : [...lines].reverse()
		// A picture (&G) stands at the band's edge, the section's text after it: below in a header, above in a footer.
		const picture = sections[section].some(run => run.kind === "field" && run.field === "picture") ? pictures[section] : undefined
		let shift = 0
		let placed: BandSection<P>["picture"] = null

		if (picture !== undefined) {
			const width = picture.width * scale
			const height = picture.height * scale

			placed = {
				left: anchor === "start" ? x : anchor === "middle" ? x - width / 2 : x - width,
				top: header ? at : at - height,
				scale,
				picture
			}
			shift = height
		}

		const shown: { y: number; pieces: { text: string; style: HeaderFooterStyle }[] }[] = []

		ordered.forEach((line, k) => {
			const pieces: { text: string; style: HeaderFooterStyle }[] = []

			for (const run of line) {
				const last = pieces[pieces.length - 1]
				const text = runText(run, values)

				if (last !== undefined && last.style === run.style) last.text += text
				else pieces.push({ text, style: run.style })
			}

			const kept = pieces.filter(piece => piece.text !== "")

			if (kept.length > 0) shown.push({ y: header ? at + shift + k * lineHeight : at - shift - k * lineHeight, pieces: kept })
		})

		out.push({ x, anchor, picture: placed, lines: shown })
	}

	return out
}

function band(
	sections: HeaderFooterSections,
	values: HeaderFooterValues,
	area: { readonly left: number; readonly right: number },
	at: number,
	header: boolean,
	font: string,
	scale: number,
	pictures: BandPictures
): string {
	let out = ""

	for (const section of bandLayout(sections, values, area, at, header, scale, pictures)) {
		const placed = section.picture

		if (placed !== null)
			out += `<g transform="translate(${number(placed.left)} ${number(placed.top)}) scale(${String(placed.scale)})">${placed.picture.markup}</g>`

		for (const line of section.lines) {
			const content = line.pieces.map(piece => tspan(piece.text, piece.style, font, DEFAULT_POINTS, scale)).join("")

			out +=
				`<text x="${number(section.x)}" y="${number(line.y)}" text-anchor="${section.anchor}" dominant-baseline="${header ? "text-before-edge" : "text-after-edge"}">` +
				`${content}</text>`
		}
	}

	return out
}

// A page's cells (the title rows and columns repeated on it), conditional formatting's bars and icons, and the
// headings, drawn on `canvas` at 100 % in the page's view (or a slice's, sliceView). `textCell` hears which cell each
// text belongs to.
export function paintPrintedCells(
	canvas: GridCanvas,
	model: SheetGridModel,
	printed: PrintedSheet,
	page: PrintPage,
	theme: SheetGridTheme,
	textCell?: (row: number, col: number) => void,
	sliced?: GridView
): GridView {
	const { layout, setup } = printed
	const view = sliced ?? pageView(printed, page)
	// Draft quality prints no gridlines (and no graphics: the job leaves objects out).
	const printLayout: SheetLayout = { ...layout, gridLines: setup.gridLines && !setup.draft }
	const painters = {
		canvas,
		measurer: new TextMeasurer(canvas),
		borders: new BorderPainter(canvas),
		patterns: new PatternCache(() => null),
		...(textCell !== undefined && { textCell })
	}
	const scene = paintScene({
		model,
		sheet: printed.sheet,
		layout: printLayout,
		view,
		theme,
		scale: 1,
		pixelRatio: 1,
		rightToLeft: layout.rightToLeft
	})

	paintCells(
		painters,
		{
			model,
			sheet: printed.sheet,
			layout: printLayout,
			view,
			theme,
			scale: 1,
			pixelRatio: 1,
			inset: decoratorInset(PRINTED_DECORATORS)
		},
		(rows, cols) => decoratePane(canvas, scene, PRINTED_DECORATORS, "under", rows, cols)
	)

	for (const pane of scene.panes) decoratePane(canvas, scene, PRINTED_DECORATORS, "over", pane.rows, pane.cols)

	paintHeadings(canvas, view, theme, layout.rightToLeft)

	return view
}

export function printPageSvg(options: PrintPageOptions): string {
	const { model, printed, page, measure } = options
	const canvas = new SvgCanvas(`${options.id}-`, measure)
	const view = paintPrintedCells(canvas, model, printed, page, options.theme ?? PRINT_THEME)

	return placedPage(options, view, canvas.markup())
}

// A page around its cells' markup (drawn in `view`, the page's), placed on the paper as the setup says.
export function placedPage(options: Omit<PrintPageOptions, "measure">, view: GridView, cells: string): string {
	const { x, y, k } = pagePlacement(options.printed, view)
	const content = `<g transform="translate(${number(x)} ${number(y)}) scale(${String(k)})">${cells}${options.over ?? ""}</g>`

	return framePage(options, content)
}

// A page: its content clipped to the area inside the margins (grey when the sheet prints in black and white), and the
// header and footer.
export function framePage(
	options: Pick<PrintPageOptions, "model" | "printed" | "id" | "number" | "pages" | "values" | "first" | "theme" | "pictures">,
	content: string
): string {
	const theme = options.theme ?? PRINT_THEME
	const { setup, pagination } = options.printed
	const { paper, area, scale } = pagination
	const values: HeaderFooterValues = { ...options.values, page: options.number, pages: options.pages }
	const { headerFooter, margins } = setup
	const { texts } = bandVariant(headerFooter, options.number, options.first)
	const font = options.model.style(0).font ?? undefined
	const family = fontFamily(font, theme.font)
	const textScale = headerFooter.scaleWithDoc ? scale : 1
	const across = { left: margins.left * 72, right: paper.width - margins.right * 72 }
	const clip = `${options.id}-area`
	const gray = `${options.id}-gray`
	const pictures = options.pictures ?? { header: {}, footer: {} }

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${number(paper.width)}pt" height="${number(paper.height)}pt" ` +
		`viewBox="0 0 ${number(paper.width)} ${number(paper.height)}" style="white-space:pre" font-family="${escapeSvgText(family)}">` +
		`<clipPath id="${clip}"><rect x="${number(area.x)}" y="${number(area.y)}" width="${number(area.width)}" height="${number(area.height)}"/></clipPath>` +
		(setup.blackAndWhite ? `<filter id="${gray}"><feColorMatrix type="saturate" values="0"/></filter>` : "") +
		`<g clip-path="url(#${clip})"${setup.blackAndWhite ? ` filter="url(#${gray})"` : ""}>${content}</g>` +
		band(parseHeaderFooter(texts.header), values, across, margins.header * 72, true, family, textScale, pictures.header) +
		band(
			parseHeaderFooter(texts.footer),
			values,
			across,
			paper.height - margins.footer * 72,
			false,
			family,
			textScale,
			pictures.footer
		) +
		"</svg>"
	)
}
