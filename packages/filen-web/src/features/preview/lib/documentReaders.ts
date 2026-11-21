import { docxPageText } from "@filen/office/dom/docx"
import type { DocxDocument } from "@filen/office/react/docx"
import { noSelection, type DocumentRange, type DocumentReader, type DocumentText } from "@/lib/activeDocument"
import { DocumentTextBuilder, unitRange } from "@/lib/documentText"
import type { PagerRowView } from "@/features/preview/workers/textPager.worker"

// The readers the preview's viewers publish (activeDocument.ts): each reads what its viewer's engine already holds,
// a page or a band of rows at a time, and stops at the characters asked for.

// A PDF's pages through its viewer's find text (PdfFinder.pageText: each page read once and kept for find).
export function pdfDocumentReader(pages: number, pageText: (page: number) => Promise<string>): DocumentReader {
	return {
		units: () => Promise.resolve(pages),
		text: async (range, signal, maxChars) => {
			if (range === "selection") {
				return noSelection()
			}

			const builder = new DocumentTextBuilder(maxChars)
			const span = unitRange(range, pages)

			for (let page = span?.from ?? 1; span !== null && page <= span.to; page++) {
				signal.throwIfAborted()

				if (!builder.add(`page ${String(page)}`, await pageText(page))) {
					break
				}
			}

			signal.throwIfAborted()

			return builder.result()
		}
	}
}

// A Word document's laid-out pages, as the viewer holds them. Pages not laid out yet (a document still streaming) end
// the read as cut short.
export function docxDocumentReader(document: DocxDocument): DocumentReader {
	const pages = Math.max(document.pageCount, document.pages.length)

	return {
		units: () => Promise.resolve(pages),
		text: (range, signal, maxChars) => {
			if (range === "selection") {
				return noSelection()
			}

			signal.throwIfAborted()

			const builder = new DocumentTextBuilder(maxChars)
			const span = unitRange(range, pages)

			for (let page = span?.from ?? 1; span !== null && page <= span.to; page++) {
				const laid = document.pages[page - 1]

				if (laid === undefined) {
					builder.truncate()

					break
				}

				if (!builder.add(`page ${String(page)}`, docxPageText(laid))) {
					break
				}
			}

			return Promise.resolve(builder.result())
		}
	}
}

// A text held whole as one unit: `read` gives it as it now is (an editor's buffer), called only for a read.
export function readWholeText(read: () => string, range: DocumentRange, signal: AbortSignal, maxChars: number): Promise<DocumentText> {
	if (range === "selection") {
		return noSelection()
	}

	signal.throwIfAborted()

	const builder = new DocumentTextBuilder(maxChars)

	builder.add("text", read())

	return Promise.resolve(builder.result())
}

// A text file held whole: one unit.
export function textDocumentReader(read: () => string): DocumentReader {
	return {
		units: () => Promise.resolve(1),
		text: (range, signal, maxChars) => readWholeText(read, range, signal, maxChars)
	}
}

// Rows read per round trip to the pager worker.
const PAGER_ROWS = 200

// A text file too large to hold, read from its start through its pager worker's rows (textPager.worker.ts `after`),
// a band at a time, until the characters asked for are read or the file ends.
export function pagerDocumentReader(
	start: number,
	after: (from: number, continuation: boolean, count: number) => Promise<readonly PagerRowView[]>
): DocumentReader {
	return {
		units: () => Promise.resolve(1),
		text: async (range, signal, maxChars) => {
			if (range === "selection") {
				return noSelection()
			}

			const parts: string[] = []
			let length = 0
			let from = start
			let continuation = false
			let more = true

			while (length <= maxChars && more) {
				signal.throwIfAborted()

				const rows = await after(from, continuation, PAGER_ROWS)
				const last = rows.at(-1)

				for (const row of rows) {
					const text = row.breaks ? `${row.text}\n` : row.text

					parts.push(text)
					length += text.length
				}

				more = last !== undefined && last.end > from

				if (last !== undefined) {
					from = last.end
					continuation = !last.breaks
				}
			}

			signal.throwIfAborted()

			const builder = new DocumentTextBuilder(maxChars)

			builder.add("text", parts.join(""))

			if (more) {
				builder.truncate()
			}

			return builder.result()
		}
	}
}
