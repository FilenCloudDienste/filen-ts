import { serveDocxWorker, workerServices } from "@filen/office/dom/docx"
import { OFFICE_HYPHENATION_URLS } from "virtual:office-hyphenation"
import { OFFICE_FONTS_PATH } from "@/features/preview/lib/officeFonts"

// The documents of the page (lib/docxEngine.ts): the whole engine — package, model, fonts, layout — lives
// here. Fonts are fetched on demand from the app's own origin, at the URLs the page passes with each document;
// hyphenation patterns once per language for every document of the worker.
serveDocxWorker(
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
	options => workerServices(self, options.fontUrls ?? OFFICE_FONTS_PATH, OFFICE_HYPHENATION_URLS)
)
