import {
	tileKey,
	type SheetAbortSignal,
	type SheetId,
	type SheetLayout,
	type SheetRenderStyle,
	type SheetTile
} from "../../../core/sheet/protocol"
// The query names these modules declare (print.tiles): types only, nothing of theirs runs from here.
import type {} from "../../../core/sheet/session"
import type { HeaderFooterValues } from "../../../core/sheet/print/headerFooter"
import type { PrintPage } from "../../../core/sheet/print/paginate"
import type { SheetHeaderImage, SheetPrintNote } from "../../../core/sheet/print/xlsx"
import type { SheetDrawingObject } from "../../../core/xlsx/drawings/feature"
import { mediaContentType } from "../../../core/xlsx/drawings/mediaTypes"
import type { SheetDrawingData } from "../../../core/xlsx/drawings/render"
import { drawingImages, imageMime, inlineImageUrls, paintDrawing } from "../../docx/paint/drawing"
import { anchorBox, type SheetBox } from "../drawings/geometry"
import { SheetGridModel } from "../model"
import type { SheetGridTheme } from "../theme"
import {
	LIST_FONT_PT,
	LIST_LINE_PT,
	listFamilies,
	NOTE_FONT,
	NOTE_FONT_PX,
	NOTE_LINE_PX,
	blackAndWhite,
	chartPlacement,
	MAX_PAGE_CELLS,
	overPlacement,
	pageCount,
	printPageAt,
	PrintPageTooLarge,
	printedTile,
	shownNoteLines,
	type NotesPage,
	type PrintChart,
	type PrintJob,
	type PrintJobSheet
} from "./printLayout"
import {
	bandPictureSlot,
	bandVariant,
	framePage,
	paintPrintedCells,
	pageTiles,
	pageView,
	placedPage,
	PRINT_THEME,
	printPageSvg,
	type BandPictures
} from "./printPage"
import { planSlices, slicePage, SliceTiles, sliceView, smallPage, surveyPage, type TileFetch } from "./printSlices"
import { noteBox } from "./printRanges"
import { escapeSvgText, SvgCanvas, xmlChars } from "./svgCanvas"

// A print as a list of pages over the grid model's session: each sheet cut into pages (and the pages listing its
// notes, when it prints them at the end), then each page drawn as SVG once the tiles it shows are held, with the
// sheet's objects (pictures, shapes, charts) and shown notes placed by their anchors and clipped at the page's edge,
// and its header and footer pictures.
//
// Tiles a page needs and the grid does not hold are asked of the session and put in the grid model's own cache, as if
// the grid had fetched them: the session holds every tile it answered until its client releases it, and the cache's
// eviction releases them like any other (a release of our own could race a fetch of the grid's for the same tile).
// Styles the answer brings reach the model the same way. A page itself is drawn from a model of its own holding the
// tiles as printed (errors as the sheet prints them, black and white), which never releases anything.

// --- Tiles and the page's own model ---

async function holdTiles(model: SheetGridModel, sheet: SheetId, coordinates: readonly number[]): Promise<SheetTile[]> {
	const missing: number[] = []
	const out: SheetTile[] = []

	for (let i = 0; i + 1 < coordinates.length; i += 2) {
		const tileRow = coordinates[i] ?? 0
		const tileCol = coordinates[i + 1] ?? 0
		const held = model.tiles.peek(tileKey(sheet, tileRow, tileCol))

		if (held === undefined) missing.push(tileRow, tileCol)
		else out.push(held)
	}

	if (missing.length === 0) return out

	const answer = await model.session.tiles(sheet, Uint32Array.from(missing))

	if (answer.styles !== undefined)
		model.apply({ state: model.getSnapshot().state, patches: [], invalidated: [], layouts: [], styles: answer.styles })

	for (const tile of answer.tiles) {
		const key = tileKey(tile.sheet, tile.tileRow, tile.tileCol)

		out.push(model.tiles.peek(key) ?? tile)

		if (!model.tiles.has(key)) model.tiles.put(tile)
	}

	return out
}

// The highest render style index the tiles and the sheet's rows and columns use.
function highestStyle(tiles: readonly SheetTile[], layout: SheetLayout): number {
	let high = 0

	for (const tile of tiles) {
		for (const style of tile.styles) high = Math.max(high, style)
		for (const style of tile.layers?.runs?.runStyles ?? []) high = Math.max(high, style)
	}

	for (const style of layout.rows.styles) high = Math.max(high, style)
	for (const style of layout.cols.styles) high = Math.max(high, style)

	return high
}

// A model of one page: the tiles as printed and the live model's looks (in black and white when the sheet says).
function pageModel(live: SheetGridModel, sheet: PrintJobSheet, tiles: readonly SheetTile[]): SheetGridModel {
	const snapshot = live.getSnapshot()
	const count = highestStyle(tiles, sheet.layout) + 1
	const styles: SheetRenderStyle[] = []

	for (let index = 0; index < count; index++)
		styles.push(sheet.setup.blackAndWhite ? blackAndWhite(live.style(index)) : live.style(index))

	const model = new SheetGridModel({
		source: live.session,
		info: {
			kind: live.kind,
			sheets: snapshot.sheets,
			activeSheet: sheet.sheet,
			activeLayout: sheet.layout,
			styles: { from: 0, styles },
			writability: snapshot.writability,
			state: snapshot.state,
			date1904: live.date1904,
			protection: null,
			fileSharing: null
		}
	})

	model.setShowFormulas(snapshot.showFormulas)

	for (const tile of tiles) model.tiles.put(printedTile(tile, sheet.setup.errors))

	return model
}

// --- Objects, notes and header pictures ---

let painted = 0

// A display list as SVG markup stretched over `width` by `height` (px at 100 %, or points in a band), its pictures
// lent by the job.
async function drawingMarkup(job: PrintJob, drawing: SheetDrawingData, width: number, height: number): Promise<string> {
	const urls = new Map<string, string | undefined>()
	const media = job.media

	if (media !== null) {
		await Promise.all(
			drawingImages(drawing).map(async image => {
				const partName = image.svgPartName ?? image.partName
				const type = imageMime(image)

				if (partName !== undefined && type !== "") urls.set(partName, await media.acquire(partName, type))
			})
		)
	}

	// Bitmaps a metafile carries: object URLs the job's media revokes when the print is disposed.
	const inline = media === null ? null : inlineImageUrls(drawing, (bytes, type) => media.createBytesUrl(bytes, type))

	painted += 1

	const svg = paintDrawing(drawing, {
		document,
		idPrefix: `fop${String(painted)}-`,
		measureText: (text, font) => job.measure(font, text),
		imageUrl: image => inline?.get(image) ?? urls.get(image.svgPartName ?? image.partName ?? "")
	})

	svg.setAttribute("width", String(width))
	svg.setAttribute("height", String(height))
	svg.setAttribute("preserveAspectRatio", "none")

	// A serializer writes the characters XML forbids as they are (a text from the file): the page would not parse.
	return xmlChars(new XMLSerializer().serializeToString(svg))
}

// An object drawn once per print: a chart through the charts feature (chart.render, laid out at the object's size), a
// picture or shape through the drawings feature (drawing.render). Null when it does not draw; a failure is also
// recorded in job.failed.
function objectMarkup(job: PrintJob, sheet: PrintJobSheet, object: SheetDrawingObject, box: SheetBox): Promise<string | null> {
	const key = `${String(sheet.sheet)}:${String(object.key)}:${object.stamp}`
	let made = job.drawn.get(key)

	if (made === undefined) {
		made = (async () => {
			try {
				if (object.chartPart !== undefined) {
					const chart = await job.model.session.query("chart.render", {
						part: object.chartPart,
						width: Math.max(1, Math.round(box.width)) * 9525,
						height: Math.max(1, Math.round(box.height)) * 9525
					})

					return chart.kind === "drawing" ? await drawingMarkup(job, chart.drawing, box.width, box.height) : null
				}

				const rendered = await job.model.session.query("drawing.render", {
					sheet: sheet.sheet,
					key: object.key,
					stamp: object.stamp
				})

				return rendered?.kind === "drawing" ? await drawingMarkup(job, rendered.drawing, box.width, box.height) : null
			} catch {
				job.failed.add(key)

				return null
			}
		})()
		job.drawn.set(key, made)
	}

	return made
}

function shownNoteMarkup(note: SheetPrintNote, box: SheetBox, measure: (font: string, text: string) => number): string {
	const text = shownNoteLines(note, box, measure)
		.map(
			(line, k) =>
				`<text x="${String(box.x + 4)}" y="${String(box.y + 3 + NOTE_FONT_PX + k * NOTE_LINE_PX)}"${k === 0 && note.author !== "" ? ' font-weight="bold"' : ""}>${escapeSvgText(line)}</text>`
		)
		.join("")

	return (
		`<rect x="${String(box.x + 0.5)}" y="${String(box.y + 0.5)}" width="${String(box.width - 1)}" height="${String(box.height - 1)}" fill="#ffffe1" stroke="#000000"/>` +
		`<g style="font:${NOTE_FONT}" fill="#000000">${text}</g>`
	)
}

// What a page draws over its cells: objects and shown notes whose boxes reach into its own rows and columns, each
// placed by its anchor and clipped at the page's edge (an object across a page break prints in part on each page).
async function overMarkup(job: PrintJob, sheet: PrintJobSheet, page: PrintPage, id: string): Promise<string> {
	if (sheet.objects.length === 0 && sheet.shownNotes.length === 0) return ""

	const { axes, place, meets, clip } = overPlacement(sheet, page, pageView(sheet, page))
	let out = ""

	for (const object of sheet.objects) {
		const box = anchorBox(object.anchor, axes)

		if (!meets(box)) continue

		const markup = await objectMarkup(job, sheet, object, box)

		if (markup === null) continue

		const at = place(box)

		out += `<g transform="translate(${String(at.x)} ${String(at.y)})">${markup}</g>`
	}

	for (const note of sheet.shownNotes) {
		const box = noteBox(note, axes)

		if (meets(box)) out += shownNoteMarkup(note, place(box), job.measure)
	}

	if (out === "") return ""

	const clipId = `${id}-over`

	return `<clipPath id="${clipId}"><rect x="${String(clip.x)}" y="${String(clip.y)}" width="${String(clip.width)}" height="${String(clip.height)}"/></clipPath><g clip-path="url(#${clipId})">${out}</g>`
}

// The header and footer pictures a page shows: the sheet's first-page, even-page or odd-page set (shape ids LH, CF,
// RHFIRST, …).
async function bandPictures(
	job: PrintJob,
	sheet: PrintJobSheet,
	number: number,
	first: boolean
): Promise<{ header: BandPictures; footer: BandPictures }> {
	const header: { -readonly [K in keyof BandPictures]: BandPictures[K] } = {}
	const footer: { -readonly [K in keyof BandPictures]: BandPictures[K] } = {}
	const { pictures } = bandVariant(sheet.setup.headerFooter, number, first)

	for (const [index, image] of sheet.headerImages.entries()) {
		const slot = bandPictureSlot(image.position, pictures)

		if (slot === null) continue

		const markup = await headerPictureMarkup(job, sheet, index, image)

		if (markup !== null) (slot.header ? header : footer)[slot.side] = { markup, width: image.width, height: image.height }
	}

	return { header, footer }
}

// A header or footer picture drawn once per print, whichever pages show it.
function headerPictureMarkup(job: PrintJob, sheet: PrintJobSheet, index: number, image: SheetHeaderImage): Promise<string | null> {
	const key = `${String(sheet.sheet)}:header:${String(index)}`
	let made = job.drawn.get(key)

	if (made === undefined) {
		made = (async () => {
			if (image.image.kind === "drawing") return await drawingMarkup(job, image.image.drawing, image.width, image.height)
			if (job.media === null) return null

			const url = await job.media.acquire(image.image.partName, mediaContentType(image.image.partName))

			return url === undefined
				? null
				: `<image href="${escapeSvgText(url)}" width="${String(image.width)}" height="${String(image.height)}" preserveAspectRatio="none"/>`
		})().catch(() => {
			job.failed.add(key)

			return null
		})
		job.drawn.set(key, made)
	}

	return made
}

// A chartsheet's page: its chart drawn by the charts feature at its size.
async function chartPageMarkup(job: PrintJob, sheet: PrintJobSheet, chart: PrintChart): Promise<string> {
	const key = `${String(sheet.sheet)}:chartsheet:${chart.part}`
	let made = job.drawn.get(key)

	if (made === undefined) {
		made = (async () => {
			try {
				const rendered = await job.model.session.query("chart.render", {
					part: chart.part,
					width: chart.width,
					height: chart.height
				})
				const at = chartPlacement(sheet, chart)

				return rendered.kind === "drawing" ? await drawingMarkup(job, rendered.drawing, at.width, at.height) : null
			} catch {
				job.failed.add(key)

				return null
			}
		})()
		job.drawn.set(key, made)
	}

	const markup = await made
	const at = chartPlacement(sheet, chart)

	return markup === null ? "" : `<g transform="translate(${String(at.x)} ${String(at.y)})">${markup}</g>`
}

// In the family the lines were measured in (layOutPrint's listFont).
function notesPageMarkup(sheet: PrintJobSheet, notes: NotesPage): string {
	const { area } = sheet.pagination
	const family = escapeSvgText(listFamilies(notes.family))

	return notes.lines
		.map(
			(line, k) =>
				`<text x="${String(area.x)}" y="${String(area.y + LIST_FONT_PT + k * LIST_LINE_PT)}" font-family="${family}" font-size="${String(LIST_FONT_PT)}"${line.bold ? ' font-weight="bold"' : ""}>${escapeSvgText(line.text)}</text>`
		)
		.join("")
}

export interface PrintRenderOptions {
	readonly job: PrintJob
	// The file's name and path (&F, &Z) and the date and time (&D, &T) as the app formats them.
	readonly values: Omit<HeaderFooterValues, "page" | "pages" | "sheet">
	// Keeps the SVGs' ids apart from any other print's in the document.
	readonly id: string
	readonly theme?: SheetGridTheme
	// Checked between the slices of a large page: the page is given up (an AbortError) once it is set.
	readonly signal?: SheetAbortSignal
}

// Cells one slice of a large page draws on the page's thread in one turn (printSlices.ts).
const SVG_SLICE_CELLS = 4_096

// A macrotask: input and the page's own work run between two slices.
function turn(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

// The render styles each print's large pages have brought, so each asks for the new ones only.
const knownStyles = new WeakMap<PrintJob, number>()

// A large page's cells drawn slice by slice (printSlices.ts): tiles through print.tiles, which holds nothing for the
// grid; the styles they bring reach the grid model as holdTiles's do.
async function slicedCells(options: PrintRenderOptions, sheet: PrintJobSheet, page: PrintPage, index: number, id: string): Promise<string> {
	const { job } = options
	const model = job.model
	const aborted = (): void => {
		if (options.signal?.aborted === true) throw Object.assign(new Error("The print was aborted"), { name: "AbortError" })
	}
	const between = async (): Promise<void> => {
		aborted()
		await turn()
		aborted()
	}
	const fetch: TileFetch = async coordinates => {
		const known = knownStyles.get(job) ?? 0
		const answer = await model.session.query("print.tiles", { sheet: sheet.sheet, coordinates, known })

		if (answer.styles.styles.length > 0) {
			model.apply({ state: model.getSnapshot().state, patches: [], invalidated: [], layouts: [], styles: answer.styles })
			knownStyles.set(job, Math.max(known, answer.styles.from + answer.styles.styles.length))
		}

		return answer.tiles
	}
	const survey = await surveyPage(page, fetch, MAX_PAGE_CELLS, between)

	if (survey === null) throw new PrintPageTooLarge(index + 1)

	const tiles = new SliceTiles(page, fetch, between)
	let markup = ""

	for (const [k, span] of planSlices(page, survey, sheet.layout.merges, SVG_SLICE_CELLS).entries()) {
		await between()

		const slice = slicePage(page, span, k === 0)
		const { view, top } = sliceView(sheet, page, slice, k === 0)
		const held = await tiles.take(slice)
		const sliceModel = pageModel(model, sheet, held)
		const canvas = new SvgCanvas(`${id}-${String(k)}-`, job.measure)

		paintPrintedCells(canvas, sliceModel, sheet, slice, options.theme ?? PRINT_THEME, undefined, view)
		sliceModel.dispose()
		tiles.drop(slice)
		markup += top === 0 ? canvas.markup() : `<g transform="translate(0 ${String(top)})">${canvas.markup()}</g>`
	}

	return markup
}

// The nth page as SVG markup, or null past the last.
export async function renderPrintPage(options: PrintRenderOptions, index: number): Promise<string | null> {
	const { job } = options
	const found = printPageAt(job, index)

	if (found === null) return null

	const id = `${options.id}-${String(index)}`
	const common = {
		printed: found.sheet,
		id,
		number: found.number,
		pages: pageCount(job),
		first: found.first,
		values: { ...options.values, sheet: found.sheet.name },
		pictures:
			found.sheet.headerImages.length === 0
				? { header: {}, footer: {} }
				: await bandPictures(job, found.sheet, found.number, found.first),
		...(options.theme !== undefined && { theme: options.theme })
	}

	if (found.sheet.chart !== null)
		return framePage({ ...common, model: job.model }, await chartPageMarkup(job, found.sheet, found.sheet.chart))

	if (found.page === null)
		return framePage({ ...common, model: job.model }, found.notes === null ? "" : notesPageMarkup(found.sheet, found.notes))

	const over = await overMarkup(job, found.sheet, found.page, id)
	const coordinates = pageTiles(found.page)

	if (!smallPage(coordinates)) {
		const cells = await slicedCells(options, found.sheet, found.page, index, id)

		return placedPage({ ...common, model: job.model, page: found.page, over }, pageView(found.sheet, found.page), cells)
	}

	const tiles = await holdTiles(job.model, found.sheet.sheet, coordinates)
	// Drawn in the turn the tiles landed: no frame of the grid evicts them first.
	const model = pageModel(job.model, found.sheet, tiles)
	const svg = printPageSvg({ ...common, model, page: found.page, measure: job.measure, over })

	model.dispose()
	// The grid trims its cache to what it shows on its next frame.
	job.model.repaint()

	return svg
}
