import { pageRangesCount, pageRangesPages, type PageRange } from "@filen/office/core/pdfedit/pageRanges"
import { pdfBox, type PdfPage, type PdfViewport } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { createPrintRoot, type PrintRoot } from "@/lib/print/printRoot"
import { pdfPrintCanvas, pdfPrintEncoding } from "@/features/pdf/print/pdfPrint.logic"

// Prints a PDF's pages from pdf.js: each page rendered with the print intent (the annotations flagged for printing)
// onto a canvas at the chosen resolution, encoded, and shown in the shared print root at the page's own size. Pending
// redaction marks (Redact annotations not yet applied) are filled black over the rendering, so what they cover never
// reaches the printer (after the swap the editor's engine draws them so itself). Pages
// are rendered one after another and each canvas is released once its picture is made, so one page's pixels are alive
// at a time. Firefox renders each page itself while it prints (mozPrintCallback), so nothing is made beforehand there.

// pdf.js AnnotationMode.
const ANNOTATIONS_NONE = 0
const ANNOTATIONS_APPEARANCES = 1
// The side of the sample a page's encoding is judged from (pdfPrintEncoding).
const SAMPLE_SIDE = 64
const JPEG_QUALITY = 0.9

export interface PdfPrintJob {
	readonly document: PdfDomDocument
	readonly ranges: readonly PageRange[]
	readonly dpi: number
	readonly maxPixels: number
	readonly annotations: boolean
	readonly signal: AbortSignal
	readonly onProgress?: (done: number, total: number) => void
}

// Firefox's print callback: the canvas is drawn into for the printer while the print dialog runs.
interface MozPrintContext {
	readonly context: CanvasRenderingContext2D
	done(): void
	abort(): void
}

function lazyPrintSupported(): boolean {
	return typeof HTMLCanvasElement !== "undefined" && "mozPrintCallback" in HTMLCanvasElement.prototype
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			blob => {
				if (blob === null) reject(new Error("canvas could not be encoded"))
				else resolve(blob)
			},
			type,
			type === "image/jpeg" ? JPEG_QUALITY : undefined
		)
	})
}

// The rendered page's encoding, from a small downscaled copy of it.
function encodingOf(canvas: HTMLCanvasElement): "image/jpeg" | "image/png" {
	const sample = document.createElement("canvas")

	sample.width = SAMPLE_SIDE
	sample.height = SAMPLE_SIDE

	const context = sample.getContext("2d", { willReadFrequently: true })

	if (context === null) return "image/png"

	context.drawImage(canvas, 0, 0, SAMPLE_SIDE, SAMPLE_SIDE)

	return pdfPrintEncoding(context.getImageData(0, 0, SAMPLE_SIDE, SAMPLE_SIDE).data)
}

type PageLayout = ReturnType<typeof pageLayout>

// A page's size in points with its own /Rotate, and the canvas it prints on.
function pageLayout(page: PdfPage, job: PdfPrintJob) {
	const viewport = page.getViewport({ scale: 1 })
	const canvas = pdfPrintCanvas(viewport.width, viewport.height, job.dpi, job.maxPixels)

	return { width: viewport.width, height: viewport.height, canvas, viewport: page.getViewport({ scale: canvas.scale }) }
}

// The rectangle of each pending redaction mark of the page (pdf.js annotation data), in the page's user space.
export function redactionRects(annotations: readonly unknown[]): (readonly [number, number, number, number])[] {
	const rects: (readonly [number, number, number, number])[] = []

	for (const annotation of annotations) {
		if (typeof annotation !== "object" || annotation === null || Reflect.get(annotation, "subtype") !== "Redact") continue

		const rect: unknown = Reflect.get(annotation, "rect")

		if (Array.isArray(rect) && rect.length === 4 && rect.every(value => typeof value === "number" && Number.isFinite(value)))
			rects.push([rect[0] as number, rect[1] as number, rect[2] as number, rect[3] as number])
	}

	return rects
}

async function fillRedactions(page: PdfPage, viewport: PdfViewport, context: CanvasRenderingContext2D): Promise<void> {
	const rects = redactionRects(await page.getAnnotations({ intent: "print" }))

	if (rects.length === 0) return

	context.save()
	context.setTransform(1, 0, 0, 1, 0, 0)
	context.fillStyle = "#000"

	for (const [x0, y0, x1, y1] of rects) {
		const [ax, ay] = viewport.convertToViewportPoint(x0, y0)
		const [bx, by] = viewport.convertToViewportPoint(x1, y1)
		const box = pdfBox(Number(ax), Number(ay), Number(bx), Number(by))

		context.fillRect(Math.floor(box.left), Math.floor(box.top), Math.ceil(box.width) + 1, Math.ceil(box.height) + 1)
	}

	context.restore()
}

async function renderInto(
	page: PdfPage,
	layout: PageLayout,
	job: PdfPrintJob,
	canvas: HTMLCanvasElement,
	context: CanvasRenderingContext2D | null
): Promise<void> {
	const task = page.render({
		canvas,
		...(context === null ? {} : { canvasContext: context }),
		viewport: layout.viewport,
		intent: "print",
		annotationMode: job.annotations ? ANNOTATIONS_APPEARANCES : ANNOTATIONS_NONE
	})
	const cancel = (): void => {
		task.cancel()
	}

	job.signal.addEventListener("abort", cancel, { once: true })
	await task.promise.finally(() => {
		job.signal.removeEventListener("abort", cancel)
	})

	const drawn = context ?? canvas.getContext("2d")

	if (drawn === null) throw new Error("no canvas to print on")

	await fillRedactions(page, layout.viewport, drawn)
}

// Every page as an encoded picture in the root.
async function addRenderedPages(root: PrintRoot, job: PdfPrintJob, total: number): Promise<void> {
	let done = 0

	for (const number of pageRangesPages(job.ranges)) {
		job.signal.throwIfAborted()

		const page = await job.document.getPage(number)
		const layout = pageLayout(page, job)
		const canvas = document.createElement("canvas")

		canvas.width = layout.canvas.width
		canvas.height = layout.canvas.height

		await renderInto(page, layout, job, canvas, null)

		const blob = await toBlob(canvas, encodingOf(canvas))
		const url = URL.createObjectURL(blob)
		const picture = document.createElement("img")

		// The canvas's pixels go now; the encoded picture is all the root keeps.
		canvas.width = 0
		canvas.height = 0
		page.cleanup()
		root.keepUrl(url)
		picture.alt = ""
		picture.src = url
		root.addPage({ width: layout.width, height: layout.height, unit: "pt" }).append(picture)
		job.onProgress?.(++done, total)
	}
}

// One canvas per page that Firefox draws when it prints: only the page sizes are read beforehand.
async function addLazyPages(root: PrintRoot, job: PdfPrintJob, total: number): Promise<void> {
	let done = 0

	for (const number of pageRangesPages(job.ranges)) {
		job.signal.throwIfAborted()

		const page = await job.document.getPage(number)
		const layout = pageLayout(page, job)
		const canvas = document.createElement("canvas")

		canvas.width = layout.canvas.width
		canvas.height = layout.canvas.height
		Reflect.set(canvas, "mozPrintCallback", (print: MozPrintContext) => {
			renderInto(page, layout, job, canvas, print.context).then(
				() => {
					page.cleanup()
					print.done()
				},
				() => {
					print.abort()
				}
			)
		})
		root.addPage({ width: layout.width, height: layout.height, unit: "pt" }).append(canvas)
		job.onProgress?.(++done, total)
	}
}

// Prints the pages; resolves once the print dialog closed, rejects with the abort's reason when cancelled first.
export async function printPdf(job: PdfPrintJob): Promise<void> {
	const root = createPrintRoot()
	const total = pageRangesCount(job.ranges)

	try {
		if (lazyPrintSupported()) await addLazyPages(root, job, total)
		else await addRenderedPages(root, job, total)

		await root.print({ signal: job.signal })
	} finally {
		root.dispose()
	}
}
