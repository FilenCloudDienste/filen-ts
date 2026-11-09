import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import type { PdfByteStream, PdfFontAssets } from "../core/pdfwrite/fonts/assets"
import type { SheetSessionApi, SheetWorkbookInfo } from "../core/sheet/protocol"
import type { SheetPdfRequest } from "../react/sheet/print/pdfExport"
import type { PrintSheetRequest } from "../react/sheet/print/printLayout"

// The PDF font assets from the package's own files, a PDF's parts as one buffer (tests write no Blob parts), and a
// workbook's print request.

const ASSETS = new URL("../../assets/fonts/", import.meta.url)

export const nodeFontAssets: PdfFontAssets = {
	open: file => Promise.resolve(Readable.toWeb(createReadStream(new URL(file, ASSETS))) as unknown as PdfByteStream)
}

export function pdfBytes(parts: readonly (Uint8Array | { readonly size: number })[]): Uint8Array {
	const chunks = parts.filter((part): part is Uint8Array => part instanceof Uint8Array)

	if (chunks.length !== parts.length) throw new Error("A part is not bytes")

	return Uint8Array.from(Buffer.concat(chunks))
}

// Every visible worksheet with its own settings, as the print dialog's "Entire workbook" prints it.
export async function workbookRequest(session: SheetSessionApi, info: SheetWorkbookInfo, file: string): Promise<SheetPdfRequest> {
	const sheets: PrintSheetRequest[] = []

	for (const sheet of info.sheets) {
		if (sheet.state !== "visible" || sheet.kind !== "worksheet") continue

		const settings = await session.query("print.settings", { sheet: sheet.id })

		if (settings === null) continue

		sheets.push({
			sheet: sheet.id,
			name: sheet.name,
			setup: settings.setup,
			used: settings.used,
			ranges: settings.setup.printArea ?? (settings.used === null ? [] : [settings.used])
		})
	}

	for (const request of sheets) await session.layout(request.sheet)
	for (let k = 0; k < 30; k++) await new Promise(resolve => setTimeout(resolve, 0))

	return {
		sheets,
		values: { date: "1/2/2026", time: "10:00", file, path: "" },
		title: file,
		lang: "en",
		kind: info.kind,
		summaries: info.sheets,
		date1904: info.date1904,
		showFormulas: false
	}
}
