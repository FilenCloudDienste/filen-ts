import type { PdfFontAssets } from "@filen/office/core/pdfwrite/fonts"
import { OFFICE_PDF_FONT_URLS } from "virtual:office-pdf-fonts"

// The faces a PDF export embeds (gzip'd TrueType, decompressed by the worker), fetched from the app's origin on first
// use through the HTTP cache. Workers only: nothing on the page imports the PDF writer.
export const officePdfFontAssets: PdfFontAssets = {
	open: async file => {
		const url = OFFICE_PDF_FONT_URLS[file]

		if (url === undefined) {
			throw new Error(`The PDF font ${file} is not served`)
		}

		const response = await fetch(url)

		if (!response.ok || response.body === null) {
			throw new Error(`The PDF font ${file}: HTTP ${String(response.status)}`)
		}

		const reader = response.body.getReader()

		return {
			getReader: () => ({
				read: async () => {
					const chunk = await reader.read()

					return chunk.done ? { done: true } : { done: false, value: chunk.value }
				},
				cancel: (reason?: unknown) => reader.cancel(reason)
			})
		}
	}
}

// A face's body read synchronously, for a worker whose reader cannot await (the MuPDF read role's font hook): a
// same-origin XMLHttpRequest through the HTTP cache. Throws when the face is not served or the request fails.
export function fetchOfficePdfFontSync(file: string): Uint8Array {
	const url = OFFICE_PDF_FONT_URLS[file]

	if (url === undefined) {
		throw new Error(`The PDF font ${file} is not served`)
	}

	const request = new XMLHttpRequest()

	request.open("GET", url, false)
	request.responseType = "arraybuffer"
	request.send()

	if (request.status !== 200 || !(request.response instanceof ArrayBuffer)) {
		throw new Error(`The PDF font ${file}: HTTP ${String(request.status)}`)
	}

	return new Uint8Array(request.response)
}
