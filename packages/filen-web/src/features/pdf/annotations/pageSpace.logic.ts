import { normalizeRect, rgbOf, type PdfAnnotationInfo, type PdfPoint, type PdfRect } from "@filen/office/core/pdfedit/annotations"
import type { PdfViewport } from "@filen/office/dom/pdf"
import { PageViewport } from "@filen/office/react/pdfedit"
import type { PdfTextLine } from "@filen/office/react/pdfedit/tools"

// A page's annotation space as the tools work in it: MuPDF's page space (points, origin at the top left of the page
// as its own /Rotate and crop show it, y down), whichever engine draws the page. A viewport (pdf.js's or the editor's)
// maps the page's user space to the view, with the view's own rotation on top of the page's; the tools draw unrotated
// in page space and the overlay turns with the view.

export type ViewRotation = 0 | 90 | 180 | 270

export interface PageSpace {
	// [0, 0, width, height] in points.
	readonly box: PdfRect
	// CSS pixels per point.
	readonly scale: number
	// The view's rotation on top of the page's own, clockwise.
	readonly rotation: ViewRotation
	// A point of the page element (CSS pixels from its top left, as the view shows it) in page space.
	toPage(x: number, y: number): PdfPoint
	// A point of the page's user space (pdf.js annotation and text coordinates) in page space.
	fromUser(x: number, y: number): PdfPoint
	// A point of page space in the page element (CSS pixels), as the view shows it.
	toView(x: number, y: number): PdfPoint
}

// A rect of page space as the page element's CSS box (left, top, width, height) the view shows it in.
export function viewBox(space: PageSpace, rect: PdfRect): { left: number; top: number; width: number; height: number } {
	const [ax, ay] = space.toView(rect[0], rect[1])
	const [bx, by] = space.toView(rect[2], rect[3])

	return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

function turn(degrees: number): ViewRotation {
	const value = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360

	return value === 90 || value === 180 || value === 270 ? value : 0
}

function pair(values: unknown[]): PdfPoint {
	const [x, y] = values

	return [typeof x === "number" ? x : 0, typeof y === "number" ? y : 0]
}

// `pageRotate`: the page's own /Rotate as the document reports it (0 for the editor's pages, which carry it already).
export function pageSpace(viewport: PdfViewport, pageRotate: number): PageSpace {
	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = viewport.viewBox
	const page = new PageViewport({ viewBox: [x0, y0, x1, y1], scale: 1, rotation: turn(pageRotate) })
	const fromUser = (x: number, y: number): PdfPoint => pair(page.convertToViewportPoint(x, y))

	return {
		box: [0, 0, page.width, page.height],
		scale: viewport.scale,
		rotation: turn(viewport.rotation - pageRotate),
		fromUser,
		toPage: (x, y) => {
			const [ux, uy] = pair(viewport.convertToPdfPoint(x, y))

			return fromUser(ux, uy)
		},
		toView: (x, y) => {
			const [ux, uy] = pair(page.convertToPdfPoint(x, y))

			return pair(viewport.convertToViewportPoint(ux, uy))
		}
	}
}

// The CSS box of the layer drawn in page space inside a page element of `width` × `height` CSS pixels: the page's
// unrotated size, centred and turned with the view.
export function pageLayerStyle(space: PageSpace): { width: string; height: string; left: string; top: string; transform: string } {
	const width = (space.box[2] - space.box[0]) * space.scale
	const height = (space.box[3] - space.box[1]) * space.scale
	const sideways = space.rotation === 90 || space.rotation === 270
	const outerWidth = sideways ? height : width
	const outerHeight = sideways ? width : height

	return {
		width: `${String(width)}px`,
		height: `${String(height)}px`,
		left: `${String((outerWidth - width) / 2)}px`,
		top: `${String((outerHeight - height) / 2)}px`,
		transform: `rotate(${String(space.rotation)}deg)`
	}
}

// --- The viewer's annotations before the swap (pdf.js), as the editor would list them ---

// pdf.js's annotation flags (ISO 32000-2 table 167): read-only and locked.
const READ_ONLY = 1 << 6
const LOCKED = 1 << 7
const RECT_TYPES = new Set(["FreeText", "Square", "Circle", "Stamp", "Text", "Redact", "Caret"])
const POINT_TYPES = new Set(["Ink", "Line", "Polygon", "PolyLine"])
// Not annotations the tools select (links and widgets have their own layers; popups belong to their parents).
const SKIPPED = new Set(["Popup", "Link", "Widget"])

function text(value: unknown): string {
	const str: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "str") : undefined

	return typeof str === "string" ? str : ""
}

function numberAt(value: unknown, index: number): number | null {
	const entry: unknown = Array.isArray(value) || ArrayBuffer.isView(value) ? Reflect.get(value, index) : undefined

	return typeof entry === "number" && Number.isFinite(entry) ? entry : null
}

// pdf.js's annotation data (getAnnotations) as the select tool's annotation infos, in page space. Its ids are the
// annotations' object numbers ("12R"), the same the editor uses, so a change made on one reaches the same annotation
// once the editor has the document.
export function viewerAnnotationInfos(annotations: readonly unknown[], page: number, space: PageSpace): PdfAnnotationInfo[] {
	const out: PdfAnnotationInfo[] = []

	for (const entry of annotations) {
		if (typeof entry !== "object" || entry === null) continue

		const get = (key: string): unknown => Reflect.get(entry, key)
		const type = get("subtype")
		const id = get("id")
		const rect = get("rect")
		const number = typeof id === "string" ? /^(\d+)R$/.exec(id)?.[1] : undefined
		const a = numberAt(rect, 0)
		const b = numberAt(rect, 1)
		const c = numberAt(rect, 2)
		const d = numberAt(rect, 3)

		if (typeof type !== "string" || SKIPPED.has(type) || number === undefined || get("inReplyTo") !== undefined) continue
		if (a === null || b === null || c === null || d === null) continue

		const [px0, py0] = space.fromUser(a, b)
		const [px1, py1] = space.fromUser(c, d)
		const flags = get("annotationFlags")
		const color = get("color")
		const red = numberAt(color, 0)
		const green = numberAt(color, 1)
		const blue = numberAt(color, 2)
		const border = get("borderStyle")
		const width: unknown = typeof border === "object" && border !== null ? Reflect.get(border, "width") : undefined
		const opacity = get("opacity")

		out.push({
			page,
			id: Number(number),
			type,
			rect: normalizeRect([px0, py0, px1, py1]),
			color: red !== null && green !== null && blue !== null ? rgbOf([red / 255, green / 255, blue / 255]) : null,
			interiorColor: null,
			opacity: typeof opacity === "number" ? opacity : 1,
			width: typeof width === "number" ? width : 0,
			author: text(get("titleObj")),
			// Dates and replies are read once the editor has the document (the Comments panel).
			created: null,
			modified: null,
			text: text(get("contentsObj")),
			replyTo: null,
			geometry: RECT_TYPES.has(type) ? "rect" : POINT_TYPES.has(type) ? "points" : null,
			locked: typeof flags === "number" && (flags & (READ_ONLY | LOCKED)) !== 0
		})
	}

	return out
}

// --- Text lines for a markup drag's draft (the committed quads come from the editor's own text) ---

// A text item's line in page space: the item's box from its transform (baseline origin, size, direction) and width,
// its characters' edges spread evenly (the draft only needs to follow the drag closely). Items that do not run
// horizontally on the page are left out.
export function textLines(items: readonly unknown[], space: PageSpace): PdfTextLine[] {
	const lines: PdfTextLine[] = []

	for (const item of items) {
		if (typeof item !== "object" || item === null) continue

		const str: unknown = Reflect.get(item, "str")
		const transform: unknown = Reflect.get(item, "transform")
		const width: unknown = Reflect.get(item, "width")

		if (typeof str !== "string" || str.trim() === "" || !Array.isArray(transform) || typeof width !== "number") continue

		const [a, b, , , e, f] = transform.map(value => (typeof value === "number" ? value : 0))
		const size = Math.hypot(a ?? 0, b ?? 0)

		if (size <= 0) continue

		const dx = (a ?? 0) / size
		const dy = (b ?? 0) / size
		const start = space.fromUser(e ?? 0, f ?? 0)
		const end = space.fromUser((e ?? 0) + dx * width, (f ?? 0) + dy * width)
		const top = space.fromUser((e ?? 0) - dy * size * 0.8, (f ?? 0) + dx * size * 0.8)

		// Horizontal on the page, left to right.
		if (Math.abs(end[1] - start[1]) > 0.5 || end[0] <= start[0]) continue

		const height = Math.abs(start[1] - top[1])
		const rect: PdfRect = [start[0], start[1] - height, end[0], start[1] + height * 0.25]
		const count = Array.from(str).length
		const edges = Array.from({ length: count + 1 }, (_, index) => start[0] + ((end[0] - start[0]) * index) / count)

		lines.push({ rect, edges })
	}

	// Reading order: top to bottom, then left to right on a line.
	return lines.sort((p, q) => (Math.abs(p.rect[1] - q.rect[1]) < 2 ? p.rect[0] - q.rect[0] : p.rect[1] - q.rect[1]))
}
