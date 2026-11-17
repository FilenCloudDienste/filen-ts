import {
	MUPDF_FORMATS,
	PDF_TILE_DESKTOP,
	PDF_TILE_MOBILE,
	PdfEngineError,
	type MupdfFormat,
	type MupdfLayout,
	type PdfReadMetadata
} from "@filen/office/dom/pdfedit"
import { MupdfPdfDocument } from "@filen/office/react/pdfedit"
import { pdfEngineMemory, startEngine, type PdfEngine } from "@/features/pdf/session/engineWorker"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"
import { originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { mupdf } from "@/lib/pixelBudget"

// A document MuPDF reads that is not a PDF (an e-book, a TIFF or Photoshop file), in an engine of its own: the read
// role of the PDF engine (one worker per document, an owned preview worker, so sign-out terminates it). Its pages plug
// into the PDF viewer's page column through `document`; an image file's page is also drawn whole (`renderPage`). Every
// page's images are checked against the pixel budget from their headers before anything is decoded.

// Below this pixel budget (a heap nearly filled by the file itself) the open is refused before an engine starts.
export const MUPDF_MIN_IMAGE_PIXELS = 1_000_000

// How far from the proportional page a relayout looks for the text that was on screen.
const LOCATE_RADIUS = 12

// The words of a page's text that find it again after a relayout: short enough to stay on one line however the text is
// set, long enough to be rare.
const ANCHOR_WORDS = 6
const ANCHOR_MIN_CHARS = 12

export type MupdfPageOutput =
	ImageBitmap | { readonly rgba: Uint8ClampedArray<ArrayBuffer>; readonly width: number; readonly height: number }

export interface MupdfReader {
	// The document at the current layout (PdfPages, find, outline, print).
	readonly document: MupdfPdfDocument
	readonly pageCount: number
	readonly reflowable: boolean
	readonly metadata: PdfReadMetadata
	// Reflowable formats: the book set at `layout`, and where the text that began `page` (of the document last handed
	// out) now is. A layout asked meanwhile replaces this one, which rejects "cancelled"; the document it resolves with
	// is a new one (the old one's requests answer "cancelled").
	relayout(layout: MupdfLayout, page: number): Promise<{ readonly document: MupdfPdfDocument; readonly page: number }>
	// The source pixels of the page's largest image, nothing decoded; null when it has none.
	imageExtent(page: number): Promise<{ readonly width: number; readonly height: number } | null>
	// The page drawn whole at the scale that fits `maxPixels` (an image file's never above its own pixels), as an
	// ImageBitmap the caller closes, or as RGBA. Rejects "overBudget" for a page whose image is over the open's budget.
	renderPage(
		page: number,
		options: { readonly maxPixels: number; readonly output: "bitmap" | "rgba"; readonly signal?: AbortSignal }
	): Promise<MupdfPageOutput>
	// Closes the document, the worker and its byte reads. Idempotent.
	close(): Promise<void>
}

export interface OpenMupdfReaderOptions {
	readonly origin: ByteOrigin
	// The surface asking (usePreviewAccessMode), and its preview cache scope (where a whole origin may already be).
	readonly access: OriginAccess
	readonly scope: string | null
	readonly format: MupdfFormat
	// Reflowable formats: the first layout (MuPDF's default when absent).
	readonly layout?: MupdfLayout
	// The book's language (BCP 47), when known: picks the face for Han text.
	readonly language?: string
	// The most source pixels one image of a drawn page may have: mupdfImagePixels.
	readonly maxImagePixels: number
	// Aborts the open (the engine ends); once open, close() ends it.
	readonly signal?: AbortSignal
	// The engine was poisoned (a wasm trap, out of memory) and is gone.
	readonly onPoisoned?: (message: string) => void
}

// The pixel budget for a document of `format` from `origin`: the engine's heap less the file when MuPDF reads it whole
// into that heap (pixelBudget.mupdf).
export function mupdfImagePixels(profile: DeviceProfile, origin: ByteOrigin, format: MupdfFormat): number {
	return mupdf(profile, MUPDF_FORMATS[format].readsWhole ? originSize(origin) : 0)
}

interface Laid {
	readonly document: MupdfPdfDocument
	readonly generation: number
	readonly pageCount: number
}

class Reader implements MupdfReader {
	readonly reflowable: boolean
	readonly metadata: PdfReadMetadata
	private readonly engine: PdfEngine
	private readonly tileSize: number
	private current: Laid
	private nextGeneration = 1
	// The anchor text of the page a relayout starts from, kept for a relayout asked while it runs (the view is frozen
	// on that page, and its generation's text may already be gone).
	private anchor: { readonly generation: number; readonly page: number; readonly text: Promise<string | null> } | null = null
	private closing: Promise<void> | null = null

	constructor(engine: PdfEngine, format: MupdfFormat, metadata: PdfReadMetadata, pageCount: number) {
		this.engine = engine
		this.reflowable = MUPDF_FORMATS[format].reflowable
		this.metadata = metadata
		this.tileSize = pdfMemoryConstrained() ? PDF_TILE_MOBILE : PDF_TILE_DESKTOP
		this.current = this.laid(0, pageCount)
	}

	get document(): MupdfPdfDocument {
		return this.current.document
	}

	get pageCount(): number {
		return this.current.pageCount
	}

	private laid(generation: number, pageCount: number): Laid {
		const { metadata } = this
		const document = MupdfPdfDocument.open(this.engine.client, {
			pageCount,
			tileSize: this.tileSize,
			generation,
			facts: {
				info: { Title: metadata.title ?? undefined, Author: metadata.author ?? undefined, Subject: metadata.subject ?? undefined },
				permissions: null,
				signatures: null,
				outline: null
			}
		})

		return { document, generation, pageCount }
	}

	private anchorText(from: Laid, page: number): Promise<string | null> {
		const held = this.anchor

		if (held !== null && held.generation === from.generation && held.page === page) return held.text

		const text = this.engine.client
			.call("text", { page, generation: from.generation })
			.then(({ lines }) => {
				const words = (lines.find(line => line.str.trim().length >= ANCHOR_MIN_CHARS) ?? lines[0])?.str.trim().split(/\s+/)

				return words === undefined || words.join("").length === 0 ? null : words.slice(0, ANCHOR_WORDS).join(" ")
			})
			// Its generation is gone, or the page has no text: the proportional page stands.
			.catch(() => null)

		this.anchor = { generation: from.generation, page, text }

		return text
	}

	async relayout(layout: MupdfLayout, page: number): Promise<{ readonly document: MupdfPdfDocument; readonly page: number }> {
		if (!this.reflowable) throw new PdfEngineError("badRequest", "the document has a fixed layout")

		const from = this.current
		const anchor = await this.anchorText(from, Math.min(Math.max(0, page), from.pageCount - 1))
		const generation = this.nextGeneration++
		const { client } = this.engine

		try {
			const { pageCount } = await client.call("layout", { ...layout, generation })
			const around = Math.min(pageCount - 1, Math.round((page * pageCount) / Math.max(1, from.pageCount)))
			const found = anchor === null ? null : await client.call("locate", { text: anchor, around, radius: LOCATE_RADIUS, generation })
			const laid = this.laid(generation, pageCount)

			// A later layout may have come back first.
			if (generation > this.current.generation) this.current = laid

			return { document: laid.document, page: found ?? around }
		} catch (error) {
			// Past the heap budget: the engine is done.
			if (error instanceof PdfEngineError && error.failure === "overBudget") await this.close()

			throw error
		}
	}

	imageExtent(page: number): Promise<{ readonly width: number; readonly height: number } | null> {
		return this.engine.client.call("imageExtent", { page, generation: this.current.generation })
	}

	async renderPage(
		page: number,
		options: { readonly maxPixels: number; readonly output: "bitmap" | "rgba"; readonly signal?: AbortSignal }
	): Promise<MupdfPageOutput> {
		const { signal } = options

		signal?.throwIfAborted()

		const queued = this.engine.client.queued("renderPage", {
			page,
			generation: this.current.generation,
			maxPixels: options.maxPixels,
			output: options.output
		})
		const cancel = (): void => {
			queued.cancel()
		}

		signal?.addEventListener("abort", cancel)

		let value: Awaited<typeof queued.promise>

		try {
			value = await queued.promise
		} catch (error) {
			if (error instanceof PdfEngineError && error.failure === "overBudget" && (await this.pastHeapBudget())) await this.close()

			signal?.throwIfAborted()

			throw error
		} finally {
			signal?.removeEventListener("abort", cancel)
		}

		if (signal?.aborted === true && value.output === "bitmap") value.bitmap.close()

		signal?.throwIfAborted()

		return value.output === "bitmap" ? value.bitmap : { rgba: value.rgba, width: value.width, height: value.height }
	}

	// An overBudget answer is the heap's (the engine is spent) rather than one page's image when the heap is past it.
	private async pastHeapBudget(): Promise<boolean> {
		const report = await this.engine.client.call("heap", {}).catch(() => null)

		return report !== null && report.heapBytes > pdfEngineMemory().heapBudget
	}

	close(): Promise<void> {
		this.closing ??= this.engine.close().then(() => undefined)

		return this.closing
	}
}

// Read afresh at each call (an abort can come in at any await).
function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true
}

// Opens the document in an engine of its own. Rejects a PdfEngineError: "overBudget" when the pixel budget is below
// MUPDF_MIN_IMAGE_PIXELS (no engine is started) or the heap outgrew its budget, "notSupported" for a document MuPDF
// does not read (damaged, empty, locked by DRM), "readFailed" for a byte read that failed, "closed" when aborted or
// signed out, "poisoned" for an engine that broke.
export async function openMupdfReader(options: OpenMupdfReaderOptions): Promise<MupdfReader> {
	const { format, signal } = options

	if (aborted(signal)) throw new PdfEngineError("closed", "the open was aborted")

	if (!(options.maxImagePixels >= MUPDF_MIN_IMAGE_PIXELS)) {
		throw new PdfEngineError("overBudget", `a pixel budget of ${String(options.maxImagePixels)} is below the floor`)
	}

	const engine = await startEngine({
		source: { kind: "origin", origin: options.origin, access: options.access, scope: options.scope },
		role: "read",
		read: {
			format,
			maxImagePixels: options.maxImagePixels,
			...(options.layout === undefined ? {} : { layout: options.layout }),
			...(options.language === undefined ? {} : { language: options.language })
		},
		...(signal === undefined ? {} : { signal }),
		...(options.onPoisoned === undefined ? {} : { onPoisoned: options.onPoisoned })
	})

	if (engine.opened.status !== "open") {
		await engine.close()

		throw new PdfEngineError("notSupported", "the document asks for a password")
	}

	const pageCount = engine.opened.document.pageCount
	let metadata: PdfReadMetadata

	try {
		metadata = await engine.client.call("metadata", {})
	} catch (error) {
		await engine.close()

		throw error
	}

	// Aborted once the engine had opened: nobody will close the reader, so it is closed here.
	if (aborted(signal)) {
		await engine.close()

		throw new PdfEngineError("closed", "the open was aborted")
	}

	return new Reader(engine, format, metadata, pageCount)
}
