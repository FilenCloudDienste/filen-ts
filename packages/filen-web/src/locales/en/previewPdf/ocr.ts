// "preview" namespace, PDF editor — text recognition (OCR): the Recognize text dialog, its language picker and the
// Settings › Office languages row. Spread into preview.ts; same catalog rules.
export const previewPdfOcr = {
	/** PDF editor — Tools tab button that opens the text recognition dialog */
	previewPdfOcrMenu: "Recognize text…",
	/** Text recognition dialog — title */
	previewPdfOcrTitle: "Recognize text",
	/** Text recognition dialog — what recognition does and does not do (an honest limit) */
	previewPdfOcrDescription:
		"Adds invisible, searchable text over scanned pages. The page images don't change, and recognition can contain mistakes.",
	/** Text recognition dialog — label of the choice of which pages are recognized */
	previewPdfOcrPages: "Pages",
	/** Text recognition dialog — recognize every page */
	previewPdfOcrAllPages: "All",
	/** Text recognition dialog — recognize the pages typed in the field next to it */
	previewPdfOcrRange: "Pages",
	/** Text recognition dialog — accessible name of the field for the pages to recognize */
	previewPdfOcrRangeLabel: "Pages to recognize",
	/** Text recognition dialog — how many of the chosen pages are scans that will get text; pages with text are skipped */
	previewPdfOcrScanned_one: "{{count}} scanned page will be made searchable. Pages that already have text are skipped.",
	/** Text recognition dialog — how many of the chosen pages are scans that will get text; pages with text are skipped */
	previewPdfOcrScanned_other: "{{count}} scanned pages will be made searchable. Pages that already have text are skipped.",
	/** Text recognition dialog — none of the chosen pages is a scan */
	previewPdfOcrNoScanned: "These pages already have text. Only scanned pages are recognized.",
	/** Text recognition dialog — label of the languages the pages are written in */
	previewPdfOcrLanguages: "Languages",
	/** Text recognition dialog — hint under the languages */
	previewPdfOcrLanguagesHint: "Pick the languages the pages are written in. Each one more makes recognition slower.",
	/** Text recognition language picker — the menu that adds a language */
	previewPdfOcrAddLanguage: "Add language",
	/** Text recognition language picker — accessible name of a language chip's remove button; {{language}} is its name */
	previewPdfOcrRemoveLanguage: "Remove {{language}}",
	/** Text recognition dialog — size of the language data downloaded the first time; {{size}} is an amount like "4.2 MB" */
	previewPdfOcrDownload: "One-time download: {{size}}",
	/** Text recognition dialog — the button that starts recognition */
	previewPdfOcrStart: "Recognize",
	/** Text recognition dialog — while the language data downloads; {{percent}} is 0-100 */
	previewPdfOcrDownloading: "Downloading languages… {{percent}}%",
	/** Text recognition dialog — progress over the pages: pages finished of all */
	previewPdfOcrProgress: "Page {{done}} of {{pages}}",
	/** Text recognition dialog — a page waiting its turn */
	previewPdfOcrPageWaiting: "Waiting",
	/** Text recognition dialog — the page being recognized */
	previewPdfOcrPageWorking: "Recognizing…",
	/** Text recognition dialog — a page done: how many words were found on it */
	previewPdfOcrPageWords_one: "{{count}} word",
	/** Text recognition dialog — a page done: how many words were found on it */
	previewPdfOcrPageWords_other: "{{count}} words",
	/** Text recognition dialog — a page that could not be recognized */
	previewPdfOcrPageFailed: "Couldn't be recognized",
	/** Text recognition dialog — summary when finished */
	previewPdfOcrDone_one: "{{count}} page is now searchable.",
	/** Text recognition dialog — summary when finished */
	previewPdfOcrDone_other: "{{count}} pages are now searchable.",
	/** Text recognition dialog — summary of pages that failed */
	previewPdfOcrFailed_one: "{{count}} page couldn't be recognized.",
	/** Text recognition dialog — summary of pages that failed */
	previewPdfOcrFailed_other: "{{count}} pages couldn't be recognized.",
	/** Text recognition dialog — the language data could not be downloaded or did not check out */
	previewPdfOcrModelsFailed: "The language data couldn't be downloaded. Check your connection and try again.",
	/** Text recognition dialog — recognition broke off partway; pages already recognized keep their text */
	previewPdfOcrRunFailed: "Recognition stopped because of an error. Pages already recognized keep their text.",
	/** Text recognition dialog — after Cancel */
	previewPdfOcrCancelled: "Stopped. Pages already recognized keep their text.",
	/** Settings › Office — row title: the languages scanned PDFs are recognized in */
	previewPdfOcrSettingsTitle: "Text recognition languages",
	/** Settings › Office — row description */
	previewPdfOcrSettingsDescription:
		"The languages scanned PDFs are recognized in on this device. Each one is downloaded the first time it's used.",
	/** Settings › Office — the button that opens the language picker */
	previewPdfOcrSettingsChange: "Change",
	/** Settings › Office — the language picker dialog's description */
	previewPdfOcrSettingsDialogDescription: "Recognize text in scanned PDFs in these languages.",
	/** Settings › Office — the language picker dialog's save button */
	previewPdfOcrSettingsSave: "Save",
	/** One-line status under the ribbon while the editor looks for the PDF's scanned pages */
	previewPdfOcrFinding: "Looking for scanned pages…",
	/** One-line notice under the ribbon when the editor could not look for the PDF's scanned pages */
	previewPdfOcrFindingFailed: "Couldn't look for scanned pages. Try again."
} as const
