import { writeDocxPdf, type DocxPdfReport } from "../../core/docx/pdf/write"
import type { DocxPdfDocument } from "../../core/docx/pdf/types"
import { bytesSource, type ByteSource } from "../../core/opc/index"
import type { PdfFontAssets } from "../../core/pdfwrite/fonts/index"
import { PdfWriteError, preparePassword } from "../../core/pdfwrite/index"
import { DocxEngine, type DocxEngineServices } from "./engine"
import type { DocxWorkerScope } from "./host"
import { docxPdfSnapshot } from "./pdfSnapshot"
import type { DocxErrorReason, DocxEvent, DocxOpenOptions } from "./protocol"
import {
	DocxPdfExportError,
	isDocxPdfRequest,
	reportOf,
	type DocxPdfBlob,
	type DocxPdfErrorReason,
	type DocxPdfExportOptions,
	type DocxPdfFromWorker,
	type DocxPdfInput
} from "./pdfClient"

// PDF export where the work is done (a worker on the web): a document given as its bytes is opened and laid
// out here (the Final view, as every page shows it), a snapshot from an editor is painted as it came; then the
// pages are painted into a PDF (core/docx/pdf) and handed back as a Blob. Progress goes out per page; a cancel
// stops at the next page or slice.

export interface DocxPdfRun {
	readonly options: DocxPdfExportOptions
	readonly signal: { readonly aborted: boolean; readonly reason?: unknown }
	readonly onProgress?: (phase: "layout" | "pages", done: number, total: number) => void
}

export interface DocxPdfExported {
	readonly blob: DocxPdfBlob
	readonly report: DocxPdfReport
}

function aborted(): Error {
	return Object.assign(new Error("The PDF export was aborted"), { name: "AbortError" })
}

// Opens the document in an engine of its own (Final view, retained) and lays it out.
async function laidOut(
	source: ByteSource,
	services: DocxEngineServices,
	run: DocxPdfRun
): Promise<{ engine: DocxEngine; document: DocxPdfDocument }> {
	let failure: { reason: DocxErrorReason; message: string } | undefined
	let pages = 0
	const options: DocxOpenOptions = {
		view: "final",
		retain: true,
		...(run.options.format === undefined ? {} : { format: run.options.format }),
		...(run.options.chartText === undefined ? {} : { chartText: run.options.chartText })
	}
	const engine = new DocxEngine(
		source,
		services,
		(event: DocxEvent) => {
			if (event.type === "error") failure = { reason: event.reason, message: event.message }
			else if (event.type === "pages") {
				pages = Math.max(pages, event.pageCount)
				run.onProgress?.("layout", event.pages.length > 0 ? pages : 0, event.final ? event.pageCount : 0)
			}
		},
		options
	)

	try {
		await engine.run()

		if (run.signal.aborted) throw aborted()
		if (failure !== undefined)
			throw new DocxPdfExportError(failure.reason === "needsPassword" ? "needsPassword" : "openFailed", failure.message)

		const live = engine.pdfSource()

		if (live === undefined) throw new DocxPdfExportError("openFailed", "The document could not be laid out")

		const document = await docxPdfSnapshot(live, {
			signal: run.signal,
			slicing: { pause: services.yield, sliceMs: services.sliceMs ?? 16, now: services.now ?? Date.now },
			title: run.options.title
		})

		return { engine, document }
	} catch (error) {
		engine.close()

		throw error
	}
}

// Paints a snapshot into a PDF Blob.
export async function paintDocxPdf(
	document: DocxPdfDocument,
	assets: PdfFontAssets,
	run: DocxPdfRun,
	services?: Pick<DocxEngineServices, "yield" | "sliceMs" | "now">
): Promise<DocxPdfExported> {
	const total = document.pages.length
	const result = await writeDocxPdf(document, {
		assets,
		signal: run.signal,
		...(run.options.password === undefined ? {} : { password: run.options.password }),
		...(run.options.deterministic === true ? { deterministic: true } : {}),
		...(run.options.lang === undefined ? {} : { lang: run.options.lang }),
		...(services === undefined
			? {}
			: { slicing: { pause: services.yield, sliceMs: services.sliceMs ?? 16, now: services.now ?? Date.now } }),
		onProgress: done => run.onProgress?.("pages", done, total)
	})

	const BlobClass: unknown = Reflect.get(globalThis, "Blob")

	if (typeof BlobClass !== "function") throw new DocxPdfExportError("failed", "Blob is not available")

	const blob = new (BlobClass as new (parts: readonly unknown[], options: { readonly type: string }) => DocxPdfBlob)(result.parts, {
		type: "application/pdf"
	})

	const untranslated = run.options.untranslated ?? 0

	if (untranslated <= 0) return { blob, report: result.report }

	const refused = new Map(result.report.refused)

	refused.set("untranslated", (refused.get("untranslated") ?? 0) + untranslated)

	return { blob, report: { missing: result.report.missing, refused } }
}

// A document given as its bytes, laid out here and painted.
export async function exportDocxPdf(
	source: ByteSource | Uint8Array,
	services: DocxEngineServices,
	assets: PdfFontAssets,
	run: DocxPdfRun
): Promise<DocxPdfExported> {
	// A password the PDF cannot take is refused before the document is laid out.
	if (run.options.password !== undefined) preparePassword(run.options.password)

	const { engine, document } = await laidOut(source instanceof Uint8Array ? bytesSource(source) : source, services, run)

	try {
		return await paintDocxPdf(document, assets, run, services)
	} finally {
		engine.close()
	}
}

function errorReason(error: unknown): { reason: DocxPdfErrorReason; message: string } {
	if (error instanceof DocxPdfExportError) return { reason: error.reason, message: error.message }
	if (error instanceof Error && error.name === "AbortError") return { reason: "aborted", message: error.message }
	if (error instanceof PdfWriteError && error.reason === "password") return { reason: "passwordUnsupported", message: error.message }

	return { reason: "failed", message: error instanceof Error ? error.message : String(error) }
}

// Serves PDF exports for the page: each request runs to its Blob, its progress posted as it goes; a cancel
// stops it at the next page or slice. `services` opens documents given as bytes; `assets` serves the fonts.
export function serveDocxPdfWorker(
	scope: DocxWorkerScope,
	services: (input: DocxPdfInput) => DocxEngineServices,
	assets: PdfFontAssets
): void {
	const running = new Map<number, { aborted: boolean; reason?: unknown }>()
	const post = (message: DocxPdfFromWorker): void => scope.post(message, [])

	scope.listen(data => {
		if (!isDocxPdfRequest(data)) return

		if (data.type === "cancel") {
			const signal = running.get(data.id)

			if (signal !== undefined) signal.aborted = true

			return
		}

		const signal = { aborted: false }
		const id = data.id
		const run: DocxPdfRun = {
			options: data.options,
			signal,
			onProgress: (phase, done, total) => post({ type: "progress", id, phase, done, total })
		}

		running.set(id, signal)
		void (async () => {
			try {
				const input = data.input
				const exported =
					input.kind === "bytes"
						? await exportDocxPdf(input.bytes, services(input), assets, run)
						: await paintDocxPdf(input.document, assets, run, services(input))

				post({ type: "done", id, blob: exported.blob, report: reportOf(exported.report) })
			} catch (error) {
				post({ type: "error", id, ...errorReason(error) })
			} finally {
				running.delete(id)
			}
		})()
	})
}
