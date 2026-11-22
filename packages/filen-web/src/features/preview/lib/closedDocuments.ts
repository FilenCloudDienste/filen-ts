import { driveItemName } from "@filen/shared"
import { isCompoundFile } from "@filen/office/core/cfb"
import { bytesSource, type ByteSource } from "@filen/office/core/opc"
import { docxPageText, type DocxEvent, type DocxHost, type DocxSessionApi } from "@filen/office/dom/docx"
import { openPdf, pdfPageText } from "@filen/office/dom/pdf"
import type { PresentationEvent } from "@filen/office/dom/presentation"
import type { UnitReader } from "@/lib/activeDocument"
import { DocumentTextBuilder, unitRange } from "@/lib/documentText"
import type { DriveItem } from "@/features/drive/lib/item"
import { extensionOf, itemTypeExtension, previewType } from "@/features/drive/lib/preview.logic"
import { IWORK_EXTENSIONS } from "@/features/iwork/lib/iworkPreview.logic"
import { docxFormatOf, isTextTemplate, legacyNeedsPassword } from "@/features/preview/components/docxViewer.logic"
import { DOCX_FONT_URLS, docxHost, docxLegacy, docxProtection, docxRtf } from "@/features/preview/lib/docxEngine"
import { PDFJS } from "@/features/preview/lib/pdfjsModule"
import { PDF_WORKER_SRC, pdfViewerSetup } from "@/features/preview/lib/pdfViewerSetup"
import { sheetDocumentReader } from "@/features/spreadsheet/lib/sheetDocumentReader"
import { openSheet } from "@/features/spreadsheet/lib/sheetHosts"
import { spreadsheetFileKind } from "@/features/spreadsheet/lib/fileKind"
import { sheetKindOf } from "@/features/spreadsheet/lib/sheetKind"
import { presentationFileKind } from "@/features/presentation/lib/fileKind"
import { connectPresentation, presentationPool } from "@/features/presentation/lib/presentationEngine"
import { slidesDocumentReader } from "@/features/presentation/lib/slidesDocumentReader"

// A drive file the user does not have open, read for the assistant once (read_document): its whole buffer, downloaded
// by the caller without keeping it in the preview cache, opened read-only in the engines the viewers use, and freed on
// close. Nothing renders: no page images, no slide renders, no grid.

export type ClosedDocumentKind = "pdf" | "docx" | "sheet" | "slides"

export interface ClosedDocument {
	readonly reader: UnitReader
	// A workbook's sheet names, in the reader's unit order.
	readonly sheets?: readonly string[]
	close(): void
}

// Why a file is not read: English, for the model.
export class ClosedDocumentRefusal extends Error {
	override readonly name = "ClosedDocumentRefusal"
}

// Which engine reads a file, by its preview category (as the preview opens it); null for a file that is not one of
// these documents (text, code, a CSV: the caller reads those as text), or the reason it cannot be read.
export function closedDocumentKind(item: DriveItem): ClosedDocumentKind | { readonly refused: string } | null {
	const name = driveItemName(item)
	const extension = itemTypeExtension(item)

	// A .key is an iWork category only once its head was read (a key file otherwise); as a document it is never read.
	if (IWORK_EXTENSIONS.includes(extensionOf(name).toLowerCase())) {
		return { refused: `"${name}" is a Keynote, Pages or Numbers file, which cannot be read here` }
	}

	switch (previewType(item)) {
		case "pdf":
			return "pdf"
		case "docx":
			return "docx"
		case "spreadsheet":
			// Delimited text reads as text.
			return spreadsheetFileKind(extension) === "csv" || spreadsheetFileKind(extension) === "tsv" ? null : "sheet"
		case "presentation":
			return presentationFileKind(extension)?.format === "ppt"
				? { refused: `"${name}" is a PowerPoint 97–2003 file, which cannot be read here` }
				: "slides"
		case "ebook":
			return { refused: `"${name}" is an e-book, which cannot be read here` }
		default:
			return null
	}
}

const PASSWORD = (name: string) =>
	new ClosedDocumentRefusal(`"${name}" is password-protected; it can only be read while the user has it open`)
const UNREADABLE = (name: string) => new ClosedDocumentRefusal(`"${name}" could not be read`)

function aborted(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")
}

// Settles with `promise`, or rejects once `signal` aborts (running `onAbort` first).
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
	if (signal.aborted) {
		onAbort()

		return Promise.reject(aborted(signal))
	}

	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort()
			reject(aborted(signal))
		}

		signal.addEventListener("abort", abort, { once: true })
		promise.then(
			value => {
				signal.removeEventListener("abort", abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort)
				reject(error instanceof Error ? error : new Error(String(error)))
			}
		)
	})
}

// Pages held as text, read like the open viewers' readers.
export function pageTextsReader(texts: readonly string[]): UnitReader {
	return {
		units: () => Promise.resolve(texts.length),
		text: (range, signal, maxChars) => {
			signal.throwIfAborted()

			const builder = new DocumentTextBuilder(maxChars)
			const span = unitRange(range, texts.length)

			for (let page = span?.from ?? 1; span !== null && page <= span.to; page++) {
				if (!builder.add(`page ${String(page)}`, texts[page - 1] ?? "")) {
					break
				}
			}

			return Promise.resolve(builder.result())
		}
	}
}

async function openPdfDocument(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<ClosedDocument> {
	let refusePassword: (() => void) | null = null
	const password = new Promise<never>((_, reject) => {
		refusePassword = () => {
			reject(PASSWORD(name))
		}
	})
	// pdf.js copies the bytes for its worker; the caller's buffer stays as it is.
	const opening = openPdf(
		PDFJS,
		{ kind: "bytes", bytes },
		{
			...pdfViewerSetup().shared,
			worker: { kind: "script", src: PDF_WORKER_SRC },
			onPassword: () => {
				refusePassword?.()
			}
		}
	)
	const destroy = () => {
		void opening.destroy()
	}
	const document = await untilAborted(Promise.race([opening.promise, password]), signal, destroy).catch((error: unknown) => {
		destroy()

		throw error instanceof ClosedDocumentRefusal || signal.aborted ? error : UNREADABLE(name)
	})
	const pages = document.numPages

	return {
		reader: {
			units: () => Promise.resolve(pages),
			text: async (range, readSignal, maxChars) => {
				const builder = new DocumentTextBuilder(maxChars)
				const span = unitRange(range, pages)

				for (let number = span?.from ?? 1; span !== null && number <= span.to; number++) {
					readSignal.throwIfAborted()

					const page = await document.getPage(number)
					const content = await page.getTextContent()

					page.cleanup()

					if (!builder.add(`page ${String(number)}`, pdfPageText(content.items).text)) {
						break
					}
				}

				readSignal.throwIfAborted()

				return builder.result()
			}
		},
		close: destroy
	}
}

// What a Word document's engine opens: the file itself, or a package the docx worker holds for it (an RTF's, a Word
// 97–2003 document's conversion), dropped by `release`.
interface DocxSource {
	readonly host: DocxHost
	readonly bytes: ByteSource
	readonly format: "docx" | "odt"
	release(): void
}

async function docxSource(item: DriveItem, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<DocxSource> {
	const format = docxFormatOf(name)

	if (isTextTemplate(item, bytes)) {
		throw new ClosedDocumentRefusal(`"${name}" is plain text, not a Word document`)
	}

	if (format === "rtf") {
		const opened = await docxRtf.open(bytes, { signal })

		if (opened.kind === "aborted") {
			throw aborted(signal)
		}

		if (opened.kind === "notRtf") {
			throw UNREADABLE(name)
		}

		return {
			host: opened.document.host,
			bytes: opened.document.bytes,
			format: "docx",
			release: () => {
				opened.document.release()
			}
		}
	}

	if (!isCompoundFile(bytes)) {
		return { host: docxHost, bytes: bytesSource(bytes), format, release: () => undefined }
	}

	// A compound file: an encrypted package, or a Word 97–2003 document converted where the engine runs.
	const probed = await docxProtection.open(bytesSource(bytes), { signal })

	switch (probed.kind) {
		case "aborted":
			throw aborted(signal)
		case "needsPassword":
			probed.locked.dispose()

			throw PASSWORD(name)
		case "refused":
			throw UNREADABLE(name)
		case "plain":
			break
	}

	const converted = await docxLegacy.open(bytesSource(bytes), { signal })

	if (converted.kind === "aborted") {
		throw aborted(signal)
	}

	if (converted.kind === "refused") {
		throw legacyNeedsPassword(converted.refusal) ? PASSWORD(name) : UNREADABLE(name)
	}

	return {
		host: converted.document.host,
		bytes: converted.document.bytes,
		format: "docx",
		release: () => {
			converted.document.release()
		}
	}
}

// Lays the document out once, keeping each page's text only; the engine closes as soon as the last page is laid out.
async function openDocxDocument(item: DriveItem, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<ClosedDocument> {
	const source = await docxSource(item, name, bytes, signal)
	const texts: (string | undefined)[] = []
	let session: DocxSessionApi | null = null
	const end = () => {
		session?.close()
		session = null
	}

	try {
		await untilAborted(
			new Promise<void>((resolve, reject) => {
				session = source.host(
					source.bytes,
					(event: DocxEvent) => {
						if (event.type === "pages") {
							for (const page of event.pages) {
								texts[page.index] = docxPageText(page)
							}

							if (event.final) {
								texts.length = event.pageCount
								resolve()
							}
						} else if (event.type === "error") {
							reject(event.reason === "needsPassword" ? PASSWORD(name) : UNREADABLE(name))
						}
					},
					{ view: "final", fontUrls: DOCX_FONT_URLS, format: source.format }
				)
			}),
			signal,
			end
		)
	} finally {
		end()
		source.release()
	}

	return { reader: pageTextsReader(Array.from(texts, text => text ?? "")), close: () => undefined }
}

async function openSheetDocument(item: DriveItem, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<ClosedDocument> {
	const { kind } = sheetKindOf(itemTypeExtension(item), bytes, false)
	// Transferred to the worker: a copy, as the caller's buffer may be the preview cache's.
	const result = await openSheet(bytes.slice(), { kind, signal }, () => undefined)

	switch (result.kind) {
		case "opened": {
			if (signal.aborted) {
				result.session.close()

				throw aborted(signal)
			}

			const sheets = result.info.sheets.filter(sheet => sheet.state !== "veryHidden")

			return {
				reader: sheetDocumentReader(result.session, sheets),
				sheets: sheets.map(sheet => sheet.name),
				close: () => {
					result.session.close()
				}
			}
		}
		case "needsPassword":
			result.locked.dispose()

			throw PASSWORD(name)
		case "aborted":
			throw aborted(signal)
		default:
			throw UNREADABLE(name)
	}
}

async function openSlidesDocument(item: DriveItem, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<ClosedDocument> {
	const format = presentationFileKind(itemTypeExtension(item))?.format

	if (format === undefined || format === "ppt") {
		throw UNREADABLE(name)
	}

	let settle: { resolve: (slides: number) => void; reject: (error: Error) => void } | null = null
	const opened = new Promise<number>((resolve, reject) => {
		settle = { resolve, reject }
	})
	// No render window: nothing is drawn, the slides are only parsed for their text.
	const connection = connectPresentation(
		presentationPool,
		{ kind: "bytes", bytes: bytes.slice() },
		(event: PresentationEvent) => {
			if (event.type === "opened") {
				settle?.resolve(event.info.slides.length)
			} else if (event.type === "error") {
				const locked = event.reason === "needsPassword" || event.reason === "encrypted" || event.reason === "wrongPassword"

				settle?.reject(locked ? PASSWORD(name) : UNREADABLE(name))
			}
		},
		{ format, fileName: name, viewOnly: true }
	)
	const close = () => {
		connection.dispose()
	}
	const slides = await untilAborted(opened, signal, close).catch((error: unknown) => {
		close()

		throw error
	})

	return { reader: slidesDocumentReader(connection.session, slides), close }
}

// Opens `bytes`, the whole file, for reading; close() frees what holds it.
export function openClosedDocument(
	item: DriveItem,
	bytes: Uint8Array,
	kind: ClosedDocumentKind,
	signal: AbortSignal
): Promise<ClosedDocument> {
	const name = driveItemName(item)

	switch (kind) {
		case "pdf":
			return openPdfDocument(name, bytes, signal)
		case "docx":
			return openDocxDocument(item, name, bytes, signal)
		case "sheet":
			return openSheetDocument(item, name, bytes, signal)
		case "slides":
			return openSlidesDocument(item, name, bytes, signal)
	}
}
