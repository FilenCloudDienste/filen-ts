import type * as Mupdf from "mupdf"
import type { MupdfModule, PdfPrintRender, PdfTile } from "./protocol"
import { PdfEngineRefusal } from "./context"
import { drawPendingRedactions } from "./redact/print"
import { PDF_HEAP_BASELINE } from "../../core/pdfedit/budget"

// Tile rendering from a cached display list per page: zooming and panning re-run the list without interpreting the
// page's content again. A tile is an opaque white pixmap of just its rectangle, drawn by a DrawDevice and copied once
// out of the heap for an ImageBitmap; the pixmap is destroyed before the copy leaves, so one tile holds one heap pixmap at
// a time. MuPDF has no way to abort a running draw, so the tile is the unit of work between cancellations.

// Device pixels per tile edge: smaller on phones, whose GPU uploads and memory are tighter.
export const PDF_TILE_DESKTOP = 1024
export const PDF_TILE_MOBILE = 512

// Display lists kept: the pages in view and their neighbours; others are rebuilt when they come back.
const DEFAULT_LISTS = 8

// The resource store (decoded images, fonts) levels off at about 92 MiB above a fresh heap (budget.ts). Below that the
// store lives in memory the heap already holds, and clearing it only costs decoding again; above it the heap has grown
// for other work (a save, an edit), and space the store gives back is reused instead of growing the heap further.
// Checked at most once a second while pages leave the view, never per eviction, and inside the request that evicts (no
// timer runs between a request's steps).
const STORE_LEVEL = 92 * 1024 * 1024
export const PDF_STORE_SHRINK_HEAP_BYTES = PDF_HEAP_BASELINE + STORE_LEVEL
export const PDF_STORE_SHRINK_INTERVAL_MS = 1000

// The wasm memory's size in bytes (its high-water mark: wasm memory never shrinks).
export function wasmHeapBytes(mupdf: MupdfModule): number {
	const probe = new mupdf.Buffer()
	const bytes = probe.asUint8Array().buffer.byteLength

	probe.destroy()

	return bytes
}

export interface RenderedTile {
	readonly rgba: Uint8ClampedArray<ArrayBuffer>
	readonly width: number
	readonly height: number
	readonly tile: PdfTile
}

export type PdfRotation = 0 | 90 | 180 | 270

// An image's source pixels, as its header names them (nothing decoded).
export interface ImageExtent {
	readonly width: number
	readonly height: number
}

// A page's display list; for a guarded renderer also its structured text (whitespace and image blocks kept) and the
// extent of its largest image, read from the image headers the text holds (nothing decoded).
interface PageList {
	readonly list: Mupdf.DisplayList
	readonly bounds: Mupdf.Rect
	readonly text: Mupdf.StructuredText | null
	readonly largest: ImageExtent | null
}

export interface TileRendererGuard {
	// The most source pixels one image of a drawn page may have: a page holding a larger one is refused before it is
	// drawn (MuPDF decodes an image whole, in the same heap).
	readonly maxImagePixels: number
	// The document is an image file (its page is its image): an image's extent is also taken from the page's bounds at
	// the image's resolution, the larger of that and its header's size winning.
	readonly imagePages?: boolean
}

function pixels(extent: ImageExtent | null): number {
	return extent === null ? 0 : extent.width * extent.height
}

// An image's extent from its header; for an image file's page also from the page's bounds (points) at its resolution.
function imageExtentOf(image: Mupdf.Image, bounds: Mupdf.Rect | null): ImageExtent {
	let width = image.getWidth()
	let height = image.getHeight()

	if (bounds !== null) {
		const xResolution = image.getXResolution()
		const yResolution = image.getYResolution()

		if (xResolution > 0) width = Math.max(width, Math.round(((bounds[2] - bounds[0]) * xResolution) / 72))
		if (yResolution > 0) height = Math.max(height, Math.round(((bounds[3] - bounds[1]) * yResolution) / 72))
	}

	return { width, height }
}

function dropList(entry: PageList): void {
	entry.text?.destroy()
	entry.list.destroy()
}

export class TileRenderer {
	private readonly mupdf: MupdfModule
	private readonly document: Mupdf.Document
	// The same document when it is a PDF (its print path draws annotations, widgets and redaction marks).
	private readonly pdf: Mupdf.PDFDocument | null
	private readonly maxLists: number
	private readonly guard: TileRendererGuard | null
	// Least recently used first.
	private readonly lists = new Map<number, PageList>()
	// The page being printed: its own list (a print reruns it for each tile of one page, then moves on).
	private printing: {
		readonly page: number
		readonly annotations: boolean
		readonly list: Mupdf.DisplayList
		readonly bounds: Mupdf.Rect
	} | null = null
	private readonly now: () => number
	private lastShrinkCheck = Number.NEGATIVE_INFINITY

	constructor(
		mupdf: MupdfModule,
		document: Mupdf.Document,
		maxLists = DEFAULT_LISTS,
		now: () => number = Date.now,
		guard: TileRendererGuard | null = null
	) {
		this.mupdf = mupdf
		this.document = document
		this.pdf = document.asPDF()
		this.maxLists = Math.max(1, maxLists)
		this.now = now
		this.guard = guard
	}

	private list(page: number): PageList {
		const cached = this.lists.get(page)

		if (cached !== undefined) {
			this.lists.delete(page)
			this.lists.set(page, cached)

			return cached
		}

		const loaded = this.document.loadPage(page)
		let bounds: Mupdf.Rect
		let list: Mupdf.DisplayList

		try {
			bounds = loaded.getBounds()
			list = loaded.toDisplayList(true)
		} finally {
			loaded.destroy()
		}

		let text: Mupdf.StructuredText | null = null
		let largest: ImageExtent | null = null

		if (this.guard !== null) {
			const pageBounds = this.guard.imagePages === true ? bounds : null

			try {
				text = list.toStructuredText("preserve-whitespace,preserve-images")
				text.walk({
					onImageBlock: (_bbox, _transform, image) => {
						const extent = imageExtentOf(image, pageBounds)

						if (pixels(extent) > pixels(largest)) largest = extent
					}
				})
			} catch (error) {
				text?.destroy()
				list.destroy()

				throw error
			}
		}

		const entry: PageList = { list, bounds, text, largest }

		this.lists.set(page, entry)

		for (const [oldest, old] of this.lists) {
			if (this.lists.size <= this.maxLists) break

			dropList(old)
			this.lists.delete(oldest)
		}

		return entry
	}

	// A guarded renderer's page: its structured text (whitespace and images kept; owned by the renderer, valid until the
	// page is evicted) and its bounds. The page is not checked against the guard: its text is read, not drawn.
	pageText(page: number): { readonly text: Mupdf.StructuredText; readonly bounds: Mupdf.Rect } {
		const { text, bounds } = this.list(page)

		if (text === null) throw new Error("only a guarded renderer keeps a page's text")

		return { text, bounds }
	}

	// A guarded renderer's page: its bounds and its largest image's extent (null: it has none).
	pageFacts(page: number): { readonly bounds: Mupdf.Rect; readonly largest: ImageExtent | null } {
		if (this.guard === null) throw new Error("only a guarded renderer reads a page's images")

		const { bounds, largest } = this.list(page)

		return { bounds, largest }
	}

	// A page as printed: its content, its annotations and form fields when asked, and every pending redaction mark
	// filled (the printed raster never shows what a mark covers, applied or not). Never cached with the view's lists.
	private printList(
		pdf: Mupdf.PDFDocument,
		page: number,
		print: PdfPrintRender
	): { readonly list: Mupdf.DisplayList; readonly bounds: Mupdf.Rect } {
		const held = this.printing

		if (held !== null && held.page === page && held.annotations === print.annotations) return held

		held?.list.destroy()
		this.printing = null

		const { mupdf } = this
		const loaded = pdf.loadPage(page)
		const bounds = loaded.getBounds()
		const list = new mupdf.DisplayList(bounds)
		const device = new mupdf.DisplayListDevice(list)

		try {
			loaded.runPageContents(device, mupdf.Matrix.identity)

			if (print.annotations) {
				loaded.runPageAnnots(device, mupdf.Matrix.identity)
				loaded.runPageWidgets(device, mupdf.Matrix.identity)
			}

			drawPendingRedactions(mupdf, loaded, device, mupdf.Matrix.identity)
			device.close()
		} catch (error) {
			list.destroy()

			throw error
		} finally {
			device.destroy()
			loaded.destroy()
		}

		this.printing = { page, annotations: print.annotations, list, bounds }

		return this.printing
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

	// A tile of the page; `print`: as printed (printList, a PDF's; any other document prints as shown); `once`: a page
	// drawn once (a thumbnail), straight from the page unless its list is held, so the lists of the pages in view are
	// neither evicted nor reordered. A guarded renderer always draws from the page's list, and refuses ("overBudget") a
	// page whose largest image is over its guard.
	render(page: number, scale: number, rotation: PdfRotation, tile: PdfTile, print?: PdfPrintRender, once = false): RenderedTile {
		if (this.guard !== null) {
			const entry = this.list(page)

			const largest = pixels(entry.largest)

			if (largest > this.guard.maxImagePixels)
				throw new PdfEngineRefusal("overBudget", `the page holds an image of ${largest} pixels`)

			return this.draw(entry.list, entry.bounds, scale, rotation, tile)
		}

		if (print === undefined && once) {
			const held = this.lists.get(page)

			if (held !== undefined) return this.draw(held.list, held.bounds, scale, rotation, tile)

			const loaded = this.document.loadPage(page)

			try {
				return this.draw(loaded, loaded.getBounds(), scale, rotation, tile)
			} finally {
				loaded.destroy()
			}
		}

		const { list, bounds } = print === undefined || this.pdf === null ? this.list(page) : this.printList(this.pdf, page, print)

		return this.draw(list, bounds, scale, rotation, tile)
	}

	// A tile of a page the caller loaded (and changed, unrendered elsewhere), unrotated; no list is read or kept.
	renderLoaded(page: Mupdf.Page, scale: number, tile: PdfTile): RenderedTile {
		return this.draw(page, page.getBounds(), scale, 0, tile)
	}

	private draw(
		source: { run(device: Mupdf.Device, matrix: Mupdf.Matrix): void },
		bounds: Mupdf.Rect,
		scale: number,
		rotation: PdfRotation,
		tile: PdfTile
	): RenderedTile {
		const { mupdf } = this
		const { ctm, size } = this.transform(bounds, scale, rotation)
		const x0 = Math.max(0, Math.floor(tile[0]))
		const y0 = Math.max(0, Math.floor(tile[1]))
		const x1 = Math.min(size[0], Math.ceil(tile[2]))
		const y1 = Math.min(size[1], Math.ceil(tile[3]))

		// A request's mistake, not a broken heap: a refusal leaves the engine usable.
		if (x1 <= x0 || y1 <= y0) throw new PdfEngineRefusal("badRequest", "tile outside the page")

		// RGBA cleared to opaque white: what is drawn composites onto it, so the samples are the bitmap's pixels as
		// they are and leave the heap in one copy. Freed even when the draw throws (a failed read under it).
		const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [x0, y0, x1, y1], true)

		try {
			const width = x1 - x0
			const height = y1 - y0
			const rgba = new Uint8ClampedArray(width * height * 4)

			pixmap.clear(255)

			const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)

			try {
				source.run(device, ctm)
				device.close()
			} finally {
				device.destroy()
			}

			// A view of the wasm heap: read before anything else can grow (and detach) it.
			const samples = pixmap.getPixels()
			const stride = pixmap.getStride()

			if (stride === width * 4) rgba.set(samples.subarray(0, rgba.length))
			else for (let y = 0; y < height; y++) rgba.set(samples.subarray(y * stride, y * stride + width * 4), y * width * 4)

			return { rgba, width, height, tile: [x0, y0, x1, y1] }
		} finally {
			pixmap.destroy()
		}
	}

	evict(pages: readonly number[]): void {
		let dropped = false

		if (this.printing !== null && pages.includes(this.printing.page)) {
			this.printing.list.destroy()
			this.printing = null
			dropped = true
		}

		for (const page of pages) {
			const entry = this.lists.get(page)

			if (entry !== undefined) {
				dropList(entry)
				this.lists.delete(page)
				dropped = true
			}
		}

		if (dropped) this.shrinkStore()
	}

	// Half of the resource store the dropped pages may have kept, only when the heap has grown past what the store fits
	// in, and checked at most once an interval.
	private shrinkStore(): void {
		const now = this.now()

		if (now - this.lastShrinkCheck < PDF_STORE_SHRINK_INTERVAL_MS) return

		this.lastShrinkCheck = now

		if (wasmHeapBytes(this.mupdf) >= PDF_STORE_SHRINK_HEAP_BYTES) this.mupdf.shrinkStore(50)
	}

	destroy(): void {
		this.printing?.list.destroy()
		this.printing = null

		for (const entry of this.lists.values()) dropList(entry)

		this.lists.clear()
	}
}
