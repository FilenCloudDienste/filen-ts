import type { DocxPdfRefusal } from "../../core/docx/pdf/paint"
import type { ChartText } from "../../core/drawingml/chart/builder"
import type { DocxPdfDocument } from "../../core/docx/pdf/types"
import type { DocxPdfReport } from "../../core/docx/pdf/write"
import type { DocxWorkerLike } from "./host"
import { snapshotTransfer } from "./pdfSnapshot"

export { DocxPdfSnapshotError, docxPdfSnapshot, type DocxPdfLive, type DocxPdfSnapshotOptions } from "./pdfSnapshot"

// The page's side of a PDF export (dom/docx/pdf.ts runs in the worker): one worker per export, ended with
// it, so nothing an export loaded (fonts, the laid-out document) outlives it. None of the painter or the
// engine is imported here.

// The platform's Blob, structurally (the core has no DOM typings).
export interface DocxPdfBlob {
	readonly size: number
	readonly type: string
	arrayBuffer(): Promise<ArrayBuffer>
}

// An AbortSignal, structurally.
export interface DocxPdfAbortSignal {
	readonly aborted: boolean
	addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void
	removeEventListener(type: "abort", listener: () => void): void
}

export function isBlob(value: unknown): value is DocxPdfBlob {
	const Blob: unknown = Reflect.get(globalThis, "Blob")

	return typeof Blob === "function" && value instanceof (Blob as new () => object)
}

// passwordUnsupported: the document's password is one the PDF standard security handler cannot take (SASLprep
// prohibits it, ISO 32000-2 §7.6.4.3.3), so no protected PDF can be made with it.
export type DocxPdfErrorReason = "aborted" | "needsPassword" | "openFailed" | "passwordUnsupported" | "failed" | "workerFailed"

export class DocxPdfExportError extends Error {
	readonly reason: DocxPdfErrorReason

	constructor(reason: DocxPdfErrorReason, message: string) {
		super(message)

		this.name = reason === "aborted" ? "AbortError" : "DocxPdfExportError"
		this.reason = reason
	}
}

export interface DocxPdfExportOptions {
	// The PDF is encrypted with it (AES-256): a password-protected source's own password.
	readonly password?: string
	// The title when the document names none: its file name without the extension (a tagged PDF shows one, ISO
	// 14289-1 §7.1).
	readonly title: string
	// BCP 47 language of a document that declares none: the app's locale.
	readonly lang?: string
	readonly deterministic?: boolean
	// A document given as bytes: its format (default docx).
	readonly format?: "docx" | "odt"
	// A document given as bytes: what its charts show where the file names nothing, in the app's language.
	readonly chartText?: ChartText
	// What the source file shows that the document exported leaves out (DocxRtfDocument.untranslated): reported as
	// content left out ("untranslated").
	readonly untranslated?: number
}

// What is exported: the file's bytes, laid out in the worker as every page shows them in the Final view (a buffer the
// bytes fill whole is transferred to the worker and detached, so a caller passes a copy it can lose), or a snapshot of
// a document laid out where it is edited (unsaved edits included).
export type DocxPdfInput =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly fontUrls?: Readonly<Record<string, string>> }
	| { readonly kind: "snapshot"; readonly document: DocxPdfDocument }

export interface DocxPdfExportReport {
	// Characters no face has, by ISO 15924 script, and content drawn approximately or left out, by kind.
	readonly missing: readonly (readonly [string, number])[]
	readonly refused: readonly (readonly [DocxPdfRefusal, number])[]
}

export type DocxPdfToWorker =
	| { readonly type: "export"; readonly id: number; readonly input: DocxPdfInput; readonly options: DocxPdfExportOptions }
	| { readonly type: "cancel"; readonly id: number }

export type DocxPdfFromWorker =
	| { readonly type: "progress"; readonly id: number; readonly phase: "layout" | "pages"; readonly done: number; readonly total: number }
	| { readonly type: "done"; readonly id: number; readonly blob: DocxPdfBlob; readonly report: DocxPdfExportReport }
	| { readonly type: "error"; readonly id: number; readonly reason: DocxPdfErrorReason; readonly message: string }

export function reportOf(report: DocxPdfReport): DocxPdfExportReport {
	return { missing: [...report.missing], refused: [...report.refused] }
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

export function isDocxPdfRequest(data: unknown): data is DocxPdfToWorker {
	const message = record(data)

	if (message === undefined || typeof message["id"] !== "number") return false
	if (message["type"] === "cancel") return true
	if (message["type"] !== "export") return false

	const input = record(message["input"])
	const options = record(message["options"])

	if (input === undefined || options === undefined) return false

	return (
		(input["kind"] === "bytes" && input["bytes"] instanceof Uint8Array) ||
		(input["kind"] === "snapshot" && record(input["document"]) !== undefined)
	)
}

function isFromWorker(data: unknown): data is DocxPdfFromWorker {
	const message = record(data)

	if (message === undefined || typeof message["id"] !== "number") return false

	switch (message["type"]) {
		case "progress":
			return typeof message["done"] === "number" && typeof message["total"] === "number"
		case "done":
			return isBlob(message["blob"]) && record(message["report"]) !== undefined
		case "error":
			return typeof message["reason"] === "string" && typeof message["message"] === "string"
		default:
			return false
	}
}

export interface DocxPdfProgress {
	readonly phase: "layout" | "pages"
	readonly done: number
	// 0 while unknown.
	readonly total: number
}

export interface DocxPdfExportRequest {
	readonly input: DocxPdfInput
	readonly options: DocxPdfExportOptions
	readonly signal?: DocxPdfAbortSignal
	readonly onProgress?: (progress: DocxPdfProgress) => void
}

export interface DocxPdfResultData {
	readonly blob: DocxPdfBlob
	readonly report: DocxPdfExportReport
}

// Runs one export in a fresh worker from `factory`; the worker ends with the export (done, failed or aborted).
// A snapshot's arrays are transferred (it must have been built with `copy`).
export function exportDocxPdfInWorker(factory: () => DocxWorkerLike, request: DocxPdfExportRequest): Promise<DocxPdfResultData> {
	const signal = request.signal

	if (signal?.aborted === true) return Promise.reject(new DocxPdfExportError("aborted", "The PDF export was aborted"))

	return new Promise((resolve, reject) => {
		const worker = factory()
		const id = 1
		let settled = false
		const finish = (): void => {
			settled = true
			signal?.removeEventListener("abort", onAbort)
			worker.terminate()
		}
		const onAbort = (): void => {
			if (settled) return

			worker.post({ type: "cancel", id } satisfies DocxPdfToWorker, [])
			finish()
			reject(new DocxPdfExportError("aborted", "The PDF export was aborted"))
		}

		signal?.addEventListener("abort", onAbort, { once: true })
		worker.listen(
			data => {
				if (settled || !isFromWorker(data) || data.id !== id) return

				if (data.type === "progress") {
					request.onProgress?.({ phase: data.phase, done: data.done, total: data.total })
				} else if (data.type === "done") {
					finish()
					resolve({ blob: data.blob, report: data.report })
				} else {
					finish()
					reject(new DocxPdfExportError(data.reason, data.message))
				}
			},
			() => {
				if (settled) return

				finish()
				reject(new DocxPdfExportError("workerFailed", "The PDF worker failed"))
			}
		)

		const input = request.input
		const transfer =
			input.kind === "snapshot"
				? snapshotTransfer(input.document)
				: input.bytes.buffer instanceof ArrayBuffer &&
					  input.bytes.byteOffset === 0 &&
					  input.bytes.byteLength === input.bytes.buffer.byteLength
					? [input.bytes.buffer]
					: []

		worker.post({ type: "export", id, input, options: request.options } satisfies DocxPdfToWorker, transfer)
	})
}
