import type * as Mupdf from "mupdf"
import type { MupdfModule, PdfTile } from "./protocol"

// Tile rendering from a cached display list per page: zooming and panning re-run the list without interpreting the
// page's content again. A tile is an opaque white pixmap of just its rectangle, drawn by a DrawDevice and copied once
// out of the heap for an ImageBitmap; the pixmap is destroyed before the copy leaves, so one tile holds one heap pixmap at
// a time. MuPDF has no way to abort a running draw, so the tile is the unit of work between cancellations.

// Device pixels per tile edge: smaller on phones, whose GPU uploads and memory are tighter.
export const PDF_TILE_DESKTOP = 1024
export const PDF_TILE_MOBILE = 512

// Display lists kept: the pages in view and their neighbours; others are rebuilt when they come back.
const DEFAULT_LISTS = 8

export interface RenderedTile {
	readonly rgba: Uint8ClampedArray<ArrayBuffer>
	readonly width: number
	readonly height: number
	readonly tile: PdfTile
}

export type PdfRotation = 0 | 90 | 180 | 270

export class TileRenderer {
	private readonly mupdf: MupdfModule
	private readonly document: Mupdf.PDFDocument
	private readonly maxLists: number
	// Least recently used first.
	private readonly lists = new Map<number, { readonly list: Mupdf.DisplayList; readonly bounds: Mupdf.Rect }>()

	constructor(mupdf: MupdfModule, document: Mupdf.PDFDocument, maxLists = DEFAULT_LISTS) {
		this.mupdf = mupdf
		this.document = document
		this.maxLists = Math.max(1, maxLists)
	}

	private list(page: number): { readonly list: Mupdf.DisplayList; readonly bounds: Mupdf.Rect } {
		const cached = this.lists.get(page)

		if (cached !== undefined) {
			this.lists.delete(page)
			this.lists.set(page, cached)

			return cached
		}

		const loaded = this.document.loadPage(page)
		const entry = { list: loaded.toDisplayList(true), bounds: loaded.getBounds() }

		loaded.destroy()
		this.lists.set(page, entry)

		for (const [oldest, old] of this.lists) {
			if (this.lists.size <= this.maxLists) break

			old.list.destroy()
			this.lists.delete(oldest)
		}

		return entry
	}

	// The page's device transform: scaled, rotated and moved so the page's top left is the origin.
	transform(
		bounds: Mupdf.Rect,
		scale: number,
		rotation: PdfRotation
	): { readonly ctm: Mupdf.Matrix; readonly size: readonly [number, number] } {
		const { Matrix, Rect } = this.mupdf
		const turned = Matrix.concat(Matrix.scale(scale, scale), Matrix.rotate(rotation))
		const box = Rect.transform(bounds, turned)
		const ctm = Matrix.concat(turned, Matrix.translate(-box[0], -box[1]))

		return { ctm, size: [Math.ceil(box[2] - box[0]), Math.ceil(box[3] - box[1])] }
	}

	render(page: number, scale: number, rotation: PdfRotation, tile: PdfTile): RenderedTile {
		const { mupdf } = this
		const { list, bounds } = this.list(page)
		const { ctm, size } = this.transform(bounds, scale, rotation)
		const x0 = Math.max(0, Math.floor(tile[0]))
		const y0 = Math.max(0, Math.floor(tile[1]))
		const x1 = Math.min(size[0], Math.ceil(tile[2]))
		const y1 = Math.min(size[1], Math.ceil(tile[3]))

		if (x1 <= x0 || y1 <= y0) throw new RangeError("tile outside the page")

		// RGBA cleared to opaque white: what is drawn composites onto it, so the samples are the bitmap's pixels as
		// they are and leave the heap in one copy.
		const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [x0, y0, x1, y1], true)
		const width = x1 - x0
		const height = y1 - y0
		const rgba = new Uint8ClampedArray(width * height * 4)

		pixmap.clear(255)

		const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)

		list.run(device, ctm)
		device.close()
		device.destroy()

		// A view of the wasm heap: read before anything else can grow (and detach) it.
		const samples = pixmap.getPixels()
		const stride = pixmap.getStride()

		if (stride === width * 4) rgba.set(samples.subarray(0, rgba.length))
		else for (let y = 0; y < height; y++) rgba.set(samples.subarray(y * stride, y * stride + width * 4), y * width * 4)

		pixmap.destroy()

		return { rgba, width, height, tile: [x0, y0, x1, y1] }
	}

	evict(pages: readonly number[]): void {
		let dropped = false

		for (const page of pages) {
			const entry = this.lists.get(page)

			if (entry !== undefined) {
				entry.list.destroy()
				this.lists.delete(page)
				dropped = true
			}
		}

		// Half of the resource store (decoded images, fonts) the dropped pages may have kept.
		if (dropped) this.mupdf.shrinkStore(50)
	}

	destroy(): void {
		for (const entry of this.lists.values()) entry.list.destroy()

		this.lists.clear()
	}
}
