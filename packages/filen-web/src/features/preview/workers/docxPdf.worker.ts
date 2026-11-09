import { workerServices } from "@filen/office/dom/docx"
import { serveDocxPdfWorker } from "@filen/office/dom/docx/pdf"
import { officePdfFontAssets } from "@/features/office/lib/pdfFontAssets"
import { OFFICE_HYPHENATION_URLS } from "virtual:office-hyphenation"
import { OFFICE_FONTS_PATH } from "@/features/preview/lib/officeFonts"

// PDF export of a Word document (lib/docxPdf.ts): one worker per export, ended with it. A file given as bytes is
// laid out here as the viewer lays it out; an editor's snapshot is painted as it came. The PDF faces (gzip'd
// TrueType) are fetched from the app's origin on first use and decompressed here.
serveDocxPdfWorker(
	{
		post: (message, transfer) => {
			self.postMessage(message, { transfer: [...transfer] })
		},
		listen: onMessage => {
			self.addEventListener("message", event => {
				onMessage(event.data)
			})
		}
	},
	input =>
		workerServices(self, input.kind === "bytes" ? (input.fontUrls ?? OFFICE_FONTS_PATH) : OFFICE_FONTS_PATH, OFFICE_HYPHENATION_URLS),
	officePdfFontAssets
)
