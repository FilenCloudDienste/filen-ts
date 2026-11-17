// "preview" namespace, the e-book reader (EPUB, MOBI, FB2). Spread into preview.ts; same catalog rules.
export const previewEbookReader = {
	/** E-book reader — shown instead of the book when it cannot be read: damaged, empty, locked by DRM, or a Kindle format the reader does not open */
	previewEbookUnsupported: "This e-book can't be shown here. It may be damaged or protected.",
	/** E-book reader — shown instead of the book when this device cannot hold it in memory */
	previewEbookTooLarge: "This e-book is too large to show on this device.",
	/** E-book reader — shown when part of the book could not be downloaded; a Try again button follows */
	previewEbookReadFailed: "This e-book couldn't be read. Check your connection and try again.",
	/** E-book reader — button under the read failure, opening the book again */
	previewEbookRetry: "Try again",
	/** E-book reader — button making the book's text smaller (it is laid out again) */
	previewEbookTextSmaller: "Smaller text",
	/** E-book reader — button making the book's text larger (it is laid out again) */
	previewEbookTextLarger: "Larger text",
	/** E-book reader — label of the text size control and its menu on narrow screens */
	previewEbookTextSize: "Text size",
	/** E-book reader — the current text size in points, e.g. "11 pt" */
	previewEbookTextSizeValue: "{{size}} pt",
	/** E-book reader — shown over the pages while the book is laid out again for a new text size or window size */
	previewEbookRelayout: "Laying out…",
	/** E-book reader — properties row: the book's format, e.g. "EPUB" */
	previewEbookPropertyFormat: "Format"
} as const
