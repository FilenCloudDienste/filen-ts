import type { DrawingTheme } from "../../drawingml/color"
import type { SliceClock } from "../../slicing"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../sheet/protocol"
import { partRelationships } from "../../xlsx/charts/parts"
import type { DrawingAnchor, DrawingMarker } from "../../xlsx/drawings/anchor"
import { readDrawingPart, type DrawingObjectRecord } from "../../xlsx/drawings/read"
import { ColFlag, RowFlag, rowRunAt, type XlsxColRange, type XlsxSheetModel } from "../../xlsx/model/types"
import type { XlsxWorkbook } from "../../xlsx/model/workbook"
import { decodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../../xml/index"
import type { SheetView } from "../write/sheet"
import { chartObject } from "./chart"
import { EMU_PER_PT, ShapeStyles, ShapeWriter, cmLength } from "./shapes"
import { drawingReader } from "../../drawingml/reader"

// A sheet's drawing (ECMA-376 Part 1 §20.5) as frames anchored to their cells (ODF 1.3 Part 3 §10.4.3 draw:frame
// in a table:table-cell, at its offset in the cell, LibreOffice's form): pictures as draw:image of the package's
// Pictures/ (§10.4.4), charts as chart objects (§10.4.6, chart.ts). A frame keeps its size; it moves with its cell but
// is not stretched by it (an end cell is no address the save's proof can follow on a new table). Shapes, text boxes,
// groups and connectors are written (shapes.ts). Ink, controls and hidden objects are reported; so is what a picture
// holds besides its image (cropping, rotation, effects, an outline, a link).

const EMU_PER_PX = 9525

// Files the package holds besides content.xml and styles.xml.
export class PackageFiles {
	readonly files: {
		readonly path: string
		readonly bytes: Uint8Array | string
		readonly mediaType: string
		readonly directory?: string
	}[] = []
	private readonly pictures = new Map<string, string>()
	private objects = 0

	// The path a part's picture already has, so a part placed again is not read again.
	pictureAt(part: string): string | undefined {
		return this.pictures.get(part)
	}

	picture(part: string, bytes: Uint8Array, mediaType: string): string {
		let path = this.pictures.get(part)

		if (path === undefined) {
			const name = part.slice(part.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9._-]/g, "_")

			path = `Pictures/${String(this.pictures.size + 1)}_${name}`
			this.pictures.set(part, path)
			this.files.push({ path, bytes, mediaType })
		}

		return path
	}

	object(content: string): string {
		const name = `Object ${String(++this.objects)}`

		this.files.push({ path: `${name}/content.xml`, bytes: content, mediaType: "text/xml", directory: `${name}/` })

		return name
	}

	// Lets go of the files once a package holds them (its bytes are a copy).
	release(): void {
		this.files.length = 0
	}
}

export interface SheetFrames {
	readonly frames: Map<string, string>
	readonly lostPictures: number
	readonly lostCharts: number
}

// Sizes along one axis as differences from a default size, over ranges (first, last; ascending, apart), with their
// sums before each range: what lies before an index is found in O(log n), however far it is.
class Deltas {
	private readonly firsts: number[] = []
	private readonly lasts: number[] = []
	private readonly deltas: number[] = []
	private readonly before: number[] = [0]

	add(first: number, last: number, delta: number): void {
		if (delta === 0 || last < first) return

		this.firsts.push(first)
		this.lasts.push(last)
		this.deltas.push(delta)
		this.before.push((this.before[this.before.length - 1] ?? 0) + (last - first + 1) * delta)
	}

	// The differences of the indexes before `index`.
	sumBefore(index: number): number {
		let low = 0
		let high = this.firsts.length - 1
		let found = -1

		while (low <= high) {
			const middle = (low + high) >> 1

			if ((this.firsts[middle] ?? 0) < index) {
				found = middle
				low = middle + 1
			} else high = middle - 1
		}

		if (found < 0) return 0

		const first = this.firsts[found] ?? 0

		return (this.before[found] ?? 0) + (Math.min((this.lasts[found] ?? 0) + 1, index) - first) * (this.deltas[found] ?? 0)
	}
}

// One axis of a sheet, EMU: where each index starts, its size, the index a point lies in.
class Axis {
	private readonly size: number
	private readonly parts: readonly Deltas[]

	constructor(size: number, parts: readonly Deltas[]) {
		this.size = size
		this.parts = parts
	}

	start(index: number): number {
		let total = index * this.size

		for (const part of this.parts) total += part.sumBefore(index)

		return total
	}

	sizeOf(index: number): number {
		return this.start(index + 1) - this.start(index)
	}

	// From one marker to another.
	span(from: number, fromOff: number, to: number, toOff: number): number {
		return this.start(to) - this.start(from) + Math.min(toOff, this.sizeOf(to)) - Math.min(fromOff, this.sizeOf(from))
	}

	// The index a point lies in (the last one at most) and its offset into it.
	locate(at: number, limit: number): { index: number; offset: number } {
		let low = 0
		let high = limit - 1

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if (this.start(middle) <= at) low = middle
			else high = middle - 1
		}

		return { index: low, offset: at - this.start(low) }
	}
}

// A sheet's rows and columns as axes (hidden ones of no size), built once.
class Geometry {
	readonly rows: Axis
	readonly cols: Axis

	constructor(model: XlsxSheetModel, view: SheetView) {
		const rowEmu = (props: { heightPt: number; flags: number }): number =>
			(props.flags & RowFlag.HIDDEN) !== 0 ? 0 : Math.round(view.height(props) * EMU_PER_PT)
		const defaultRow = rowEmu({ heightPt: Number.NaN, flags: model.format.zeroHeight ? RowFlag.HIDDEN : 0 })
		const runs = new Deltas()
		const cells = new Deltas()
		const rowRuns = model.rowRuns ?? []

		for (const run of rowRuns) runs.add(run.first, run.last, rowEmu(run) - defaultRow)

		// Rows with cells, over what a run or the default gives them.
		for (const block of model.store.blocks) {
			for (let index = 0; index < block.rowCount; index++) {
				const row = block.firstRow + (block.rows[index] ?? 0)
				const run = rowRunAt(rowRuns, row)

				cells.add(row, row, rowEmu(view.rowProps(row)) - (run === undefined ? defaultRow : rowEmu(run)))
			}
		}

		const colEmu = (range: XlsxColRange | undefined): number =>
			range !== undefined && (range.flags & ColFlag.HIDDEN) !== 0 ? 0 : Math.round(view.columnPx(range) * EMU_PER_PX)
		const defaultCol = colEmu(undefined)
		const columns = new Deltas()

		for (const range of [...model.cols].sort((a, b) => a.first - b.first))
			columns.add(range.first, range.last, colEmu(range) - defaultCol)

		this.rows = new Axis(defaultRow, [runs, cells])
		this.cols = new Axis(defaultCol, [columns])
	}
}

// Where an anchor puts its frame: its cell, the offset into it and its size, EMU.
function placement(anchor: DrawingAnchor, geometry: Geometry): { row: number; col: number; x: number; y: number; cx: number; cy: number } {
	const { rows, cols } = geometry
	const at = (marker: DrawingMarker): { row: number; col: number; x: number; y: number } => ({
		row: marker.row,
		col: marker.col,
		x: Math.min(marker.colOff, cols.sizeOf(marker.col)),
		y: Math.min(marker.rowOff, rows.sizeOf(marker.row))
	})

	switch (anchor.mode) {
		case "twoCell":
			return {
				...at(anchor.from),
				cx: Math.max(0, cols.span(anchor.from.col, anchor.from.colOff, anchor.to.col, anchor.to.colOff)),
				cy: Math.max(0, rows.span(anchor.from.row, anchor.from.rowOff, anchor.to.row, anchor.to.rowOff))
			}
		case "oneCell":
			return { ...at(anchor.from), cx: anchor.cx, cy: anchor.cy }
		case "absolute": {
			const col = cols.locate(anchor.x, SHEET_MAX_COLS)
			const row = rows.locate(anchor.y, SHEET_MAX_ROWS)

			return { row: row.index, col: col.index, x: col.offset, y: row.offset, cx: anchor.cx, cy: anchor.cy }
		}
	}
}

// What a picture holds besides its image, which its frame does not.
const PICTURE_EXTRAS =
	/<(?:\w+:)?(?:srcRect|ln|effectLst|scene3d|sp3d|hlinkClick|hlinkHover|duotone|grayscl|biLevel|alphaModFix|clrChange|lum|tint)\b|\s(?:rot|flipH|flipV)="(?!0")/

// Groups in groups a drawing may hold (Excel's own interface nests a few).
const MAX_GROUP_DEPTH = 64

// A drawing no conversion writes (tooLarge).
export class DrawingRefused extends Error {}

// The deepest nesting of elements in the document, walked without recursion.
function nestingDepth(document: XmlDocument): number {
	let deepest = 0
	let depth = 0
	let node = document.documentElement()

	while (node >= 0) {
		const child = document.firstChildElement(node)

		if (child >= 0) {
			node = child
			depth++
			deepest = Math.max(deepest, depth)

			continue
		}

		let next = document.nextSiblingElement(node)

		while (next < 0 && depth > 0) {
			node = document.parent(node)
			depth--
			next = node < 0 ? -1 : document.nextSiblingElement(node)
		}

		node = next
	}

	// Elements an anchor holds besides groups (an anchor, a shape, its properties, a fill, a colour): a few levels.
	return Math.max(0, deepest - 8)
}

export async function sheetFrames(
	workbook: XlsxWorkbook,
	drawingPart: string,
	sheet: string,
	model: XlsxSheetModel,
	view: SheetView,
	files: PackageFiles,
	theme: DrawingTheme,
	shapeStyles: ShapeStyles,
	clock?: SliceClock
): Promise<SheetFrames> {
	const frames = new Map<string, string>()
	let lostPictures = 0
	let lostCharts = 0
	const bytes = await workbook.parts.read(drawingPart)
	const document = parseXml(bytes)
	// Groups nested deeper than any drawing needs are refused before anything walks them (each level a recursion).
	if (nestingDepth(document) > MAX_GROUP_DEPTH)
		throw new DrawingRefused(`${drawingPart}: groups nested deeper than ${String(MAX_GROUP_DEPTH)}`)

	const record = readDrawingPart(document)
	const relationships = await partRelationships(workbook, drawingPart)
	const target = (id: string | undefined): string | undefined => {
		const relationship = relationships.find(candidate => candidate.id === id)

		return relationship === undefined || relationship.external ? undefined : relationship.partName
	}
	const geometry = new Geometry(model, view)
	let z = 0
	let shapes: ShapeWriter | undefined

	const add = (object: DrawingObjectRecord, inner: string, box: ReturnType<typeof placement>): void => {
		const key = `${String(box.row)},${String(box.col)}`
		const frame =
			`<draw:frame draw:z-index="${String(z++)}"${object.name === "" ? "" : ` draw:name="${escapeAttribute(object.name)}"`}` +
			` svg:width="${cmLength(Math.max(0, box.cx))}" svg:height="${cmLength(Math.max(0, box.cy))}" svg:x="${cmLength(Math.max(0, box.x))}" svg:y="${cmLength(Math.max(0, box.y))}">` +
			`${inner}${object.alt === "" ? "" : `<svg:desc>${escapeText(object.alt)}</svg:desc>`}</draw:frame>`

		frames.set(key, (frames.get(key) ?? "") + frame)
	}

	for (const object of record.objects) {
		if (clock?.due === true) await clock.pause()

		// A hidden object has no frame here (draw:display is a layer's, ODF 1.3 Part 3 §19.123).
		if (object.anchor === null || object.hidden) {
			if (object.kind === "chart" || object.kind === "chartex") lostCharts++
			else lostPictures++

			continue
		}

		const box = placement(object.anchor, geometry)

		if (box.row >= SHEET_MAX_ROWS || box.col >= SHEET_MAX_COLS) {
			lostPictures++

			continue
		}

		if (object.kind === "picture") {
			const markup = decodeUtf8(document.raw(object.content))
			const embed = /<(?:\w+:)?blip\b[^>]*\s(?:\w+:)?embed="([^"]*)"/.exec(markup)?.[1]
			const part = target(embed)
			const entry = part === undefined ? undefined : workbook.parts.get(part)

			if (part === undefined || entry === undefined || !/^image\//.test(entry.contentType)) {
				lostPictures++

				continue
			}

			if (PICTURE_EXTRAS.test(markup)) lostPictures++

			const path = files.pictureAt(part) ?? files.picture(part, await workbook.parts.read(part), entry.contentType)

			add(
				object,
				`<draw:image xlink:href="${escapeAttribute(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="${escapeAttribute(entry.contentType)}"/>`,
				box
			)

			continue
		}

		if (object.kind === "chart") {
			const part = target(object.chartRelationship ?? undefined)
			const chart =
				part === undefined || workbook.parts.get(part) === undefined ? null : parseChartPart(await workbook.parts.read(part))
			const written =
				chart === null ? null : chartObject(chart, theme, sheet, cmLength(Math.max(0, box.cx)), cmLength(Math.max(0, box.cy)))

			if (written === null) {
				lostCharts++

				continue
			}

			if (written.lost) lostCharts++

			const name = files.object(written.content)

			add(
				object,
				`<draw:object draw:notify-on-update-of-ranges="${escapeAttribute(written.ranges)}" xlink:href="./${escapeAttribute(name)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`,
				box
			)

			continue
		}

		// Shapes, text boxes, connectors and groups (shapes.ts), at their cell as the frames are.
		if ((object.kind === "shape" || object.kind === "connector" || object.kind === "group") && object.content >= 0) {
			const writer = (shapes ??= new ShapeWriter(document, drawingReader(document), theme, shapeStyles))
			const before = writer.lost
			const markup = writer.shape(object.content, { x: box.x, y: box.y, cx: box.cx, cy: box.cy }, z++, object.name)
			const key = `${String(box.row)},${String(box.col)}`

			if (writer.lost > before) lostPictures++

			frames.set(key, (frames.get(key) ?? "") + markup)

			continue
		}

		if (object.kind === "chartex") lostCharts++
		else lostPictures++
	}

	return { frames, lostPictures, lostCharts }
}

function parseChartPart(bytes: Uint8Array): ReturnType<typeof parseXml> | null {
	try {
		return parseXml(bytes)
	} catch {
		return null
	}
}
