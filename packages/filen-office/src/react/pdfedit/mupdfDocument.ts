import type { PdfPage, PdfRenderParams, PdfRenderTask, PdfTextContent, PdfViewport } from "../../dom/pdf/index"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import type { PdfPageInfo, PdfRenderValue, PdfTile } from "../../dom/pdfedit/protocol"
import type { PdfPageText } from "../../dom/pdfedit/text"
import type { PdfDomDocument } from "../pdf/types"
import { PageViewport } from "./viewport"

// The editor's engine (MuPDF in its worker) behind pdf.js's document contract, so the viewer's page column, text
// layer, find, links, outline, properties and printing run on it unchanged after the swap (PdfTextSource: a page's text
// lines become pdf.js text items, its links pdf.js link annotations, which go through the viewer's link gate).
// Rendering draws the engine's tiles into the canvas the column (or the print code) hands over. A document object is
// one revision: a change makes the next one (`next`), which hands out new page objects for the pages it touched only,
// so the column re-renders those and keeps the others' bitmaps and text layers.

// What the engine is asked: a PdfEngineClient.
export type PdfEditEngine = Pick<PdfEngineClient, "call" | "queued">

// What the viewer read of its pdf.js document before the swap, which the editor's engine does not serve: the
// document's information, restrictions, signatures and bookmarks (the editing tools never change them).
export interface PdfDocumentFacts {
	readonly info: unknown
	readonly permissions: ReadonlySet<number> | null
	readonly signatures: unknown[] | null
	readonly outline: readonly unknown[] | null
}

export interface MupdfDocumentOptions {
	readonly pageCount: number
	// Device pixels per tile edge (PDF_TILE_DESKTOP / PDF_TILE_MOBILE).
	readonly tileSize: number
	readonly facts: PdfDocumentFacts
}

interface PageEntry {
	readonly info: Promise<PdfPageInfo>
	readonly page: Promise<MupdfPage>
}

// What one revision chain shares: the engine, page sizes and page objects, and each page's text.
class PageStore {
	readonly engine: PdfEditEngine
	readonly tileSize: number
	private readonly pages = new Map<number, PageEntry>()
	private readonly texts = new Map<number, Promise<PdfPageText>>()

	constructor(engine: PdfEditEngine, tileSize: number) {
		this.engine = engine
		this.tileSize = tileSize
	}

	page(index: number): Promise<MupdfPage> {
		let entry = this.pages.get(index)

		if (entry === undefined) {
			const info = this.engine.call("pages", { from: index, count: 1 }).then(pages => {
				const first = pages[0]

				if (first === undefined) throw new RangeError("no such page")

				return first
			})

			entry = { info, page: info.then(read => new MupdfPage(this, index, read)) }
			this.pages.set(index, entry)
			// A failed read is not kept: the next ask reads again.
			entry.page.catch(() => {
				if (this.pages.get(index) === entry) this.pages.delete(index)
			})
		}

		return entry.page
	}

	text(index: number): Promise<PdfPageText> {
		let text = this.texts.get(index)

		if (text === undefined) {
			text = this.engine.call("text", { page: index })
			this.texts.set(index, text)
			text.catch(() => {
				if (this.texts.get(index) === text) this.texts.delete(index)
			})
		}

		return text
	}

	// The pages a change touched: read anew (size, text, and a new page object).
	touch(pages: readonly number[]): void {
		for (const page of pages) {
			this.pages.delete(page)
			this.texts.delete(page)
		}
	}

	// The page left the view: its text and the engine's display list go; its size stays.
	evict(index: number): void {
		this.texts.delete(index)
		void this.engine.call("evict", { pages: [index] }).catch(() => undefined)
	}
}

// The one text style every line uses: MuPDF gives positions and sizes, not the fonts the browser should measure with.
const TEXT_STYLE = "mupdf"
const STYLES = { [TEXT_STYLE]: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } }

function textContent(text: PdfPageText): PdfTextContent & { readonly styles: typeof STYLES; readonly lang: null } {
	return {
		items: text.lines.map(line => ({
			str: line.str,
			dir: "ltr",
			transform: [line.size * line.dx, line.size * line.dy, -line.size * line.dy, line.size * line.dx, line.x, line.y],
			width: line.width,
			height: line.size,
			fontName: TEXT_STYLE,
			hasEOL: true
		})),
		styles: STYLES,
		lang: null
	}
}

function viewportRotation(rotation: number): 0 | 90 | 180 | 270 {
	const turn = ((rotation % 360) + 360) % 360

	return turn === 90 || turn === 180 || turn === 270 ? turn : 0
}

interface CanvasLike {
	readonly width: number
	readonly height: number
	getContext(kind: "2d"): CanvasRenderingContext2D | null
}

class MupdfPage implements PdfPage<ReadableStream> {
	// The engine's pages carry their own /Rotate and UserUnit already.
	readonly rotate = 0
	readonly userUnit = 1
	readonly label: string
	private readonly store: PageStore
	private readonly index: number
	private readonly width: number
	private readonly height: number

	constructor(store: PageStore, index: number, info: PdfPageInfo) {
		this.store = store
		this.index = index
		this.width = info.width
		this.height = info.height
		this.label = info.label
	}

	getViewport({ scale, rotation }: { scale: number; rotation?: number }): PdfViewport {
		return new PageViewport({ viewBox: [0, 0, this.width, this.height], scale, rotation: rotation ?? 0 })
	}

	// Tiles of the canvas's pixels at the viewport's scale times the transform's (the device pixel ratio), drawn as they
	// arrive. Cancelling drops the tiles still queued; one being drawn finishes.
	render(params: PdfRenderParams): PdfRenderTask {
		const context =
			(params.canvasContext as CanvasRenderingContext2D | undefined) ??
			(params.canvas as CanvasLike | undefined)?.getContext("2d") ??
			null

		if (context === null) return { promise: Promise.reject(new Error("no canvas to draw into")), cancel: () => undefined }

		const { viewport } = params
		const ratio = params.transform?.[0] ?? 1
		const scale = viewport.scale * ratio
		const rotation = viewportRotation(viewport.rotation)
		const width = context.canvas.width
		const height = context.canvas.height
		const size = this.store.tileSize
		const cancels: (() => void)[] = []
		const tiles: Promise<void>[] = []
		let cancelled = false

		for (let y = 0; y < height; y += size) {
			for (let x = 0; x < width; x += size) {
				const tile: PdfTile = [x, y, Math.min(width, x + size), Math.min(height, y + size)]
				const queued = this.store.engine.queued("render", { page: this.index, scale, rotation, tile, priority: "visible" })

				cancels.push(queued.cancel)
				tiles.push(
					queued.promise.then((drawn: PdfRenderValue) => {
						const bitmap = drawn.bitmap as unknown as ImageBitmap

						if (!cancelled) context.drawImage(bitmap, drawn.tile[0], drawn.tile[1])

						drawn.bitmap.close()
					})
				)
			}
		}

		return {
			promise: Promise.all(tiles).then(() => {
				if (cancelled) throw new Error("cancelled")
			}),
			cancel: () => {
				cancelled = true

				for (const cancel of cancels) cancel()
			}
		}
	}

	streamTextContent(): ReadableStream {
		const text = this.store.text(this.index)

		return new ReadableStream({
			start: async controller => {
				try {
					controller.enqueue(textContent(await text))
					controller.close()
				} catch (error) {
					controller.error(error)
				}
			}
		})
	}

	async getTextContent(): Promise<PdfTextContent> {
		return textContent(await this.store.text(this.index))
	}

	// Its links as pdf.js gives link annotations: a URL, or an explicit destination by page index.
	async getAnnotations(): Promise<unknown[]> {
		const { links } = await this.store.text(this.index)

		return links.map(link =>
			"url" in link
				? { subtype: "Link", rect: [...link.rect], url: link.url }
				: { subtype: "Link", rect: [...link.rect], dest: [link.page, { name: "XYZ" }, link.left, link.top, null] }
		)
	}

	cleanup(): boolean {
		this.store.evict(this.index)

		return true
	}
}

export class MupdfPdfDocument implements PdfDomDocument {
	readonly numPages: number
	readonly facts: PdfDocumentFacts
	private readonly store: PageStore

	private constructor(store: PageStore, pageCount: number, facts: PdfDocumentFacts) {
		this.store = store
		this.numPages = pageCount
		this.facts = facts
	}

	static open(engine: PdfEditEngine, options: MupdfDocumentOptions): MupdfPdfDocument {
		return new MupdfPdfDocument(new PageStore(engine, options.tileSize), options.pageCount, options.facts)
	}

	// The revision after a change that touched `pages` (or every page, after an undo or redo).
	next(pages: readonly number[], pageCount: number): MupdfPdfDocument {
		this.store.touch(pages)

		return new MupdfPdfDocument(this.store, pageCount, this.facts)
	}

	getPage(pageNumber: number): Promise<PdfPage<ReadableStream>> {
		return this.store.page(pageNumber - 1)
	}

	// A named destination as an explicit one in the engine's page space.
	async getDestination(id: string): Promise<unknown[] | null> {
		const point = await this.store.engine.call("destination", { name: id })

		return point === null ? null : [point.page, { name: "XYZ" }, point.left, point.top, null]
	}

	// A page reference of pdf.js's ({ num, gen }), as an outline read before the swap holds them.
	async getPageIndex(ref: unknown): Promise<number> {
		const object: unknown = typeof ref === "object" && ref !== null ? Reflect.get(ref, "num") : undefined

		if (typeof object !== "number") throw new TypeError("not a page reference")

		const point = await this.store.engine.call("destination", { pageObject: object })

		if (point === null) throw new RangeError("no such page")

		return point.page
	}

	getOutline(): Promise<readonly unknown[] | null> {
		return Promise.resolve(this.facts.outline)
	}

	getMetadata(): Promise<{ readonly info: unknown }> {
		return Promise.resolve({ info: this.facts.info })
	}

	getPermissions(): Promise<ReadonlySet<number> | null> {
		return Promise.resolve(this.facts.permissions)
	}

	getSignatures(): Promise<unknown[] | null> {
		return Promise.resolve(this.facts.signatures)
	}
}

export function isMupdfDocument(document: unknown): document is MupdfPdfDocument {
	return document instanceof MupdfPdfDocument
}

// What the editor needs of the viewer's document before it is closed (PdfDocumentFacts).
export async function readPdfDocumentFacts(document: PdfDomDocument): Promise<PdfDocumentFacts> {
	const [metadata, permissions, signatures, outline] = await Promise.all([
		document.getMetadata().catch(() => ({ info: null })),
		document.getPermissions?.().catch(() => null) ?? Promise.resolve(null),
		document.getSignatures?.().catch(() => null) ?? Promise.resolve(null),
		document.getOutline().catch(() => null)
	])

	return { info: metadata.info, permissions, signatures, outline }
}
