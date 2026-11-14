import type { PDFDocument } from "mupdf"

// "Flatten annotations" on save: every annotation's appearance becomes page content and the annotations are removed
// (links and form fields stay). Irreversible once saved; one command over every page.
export function flattenAnnotations(document: PDFDocument): readonly number[] {
	document.bake(true, false)

	return Array.from({ length: document.countPages() }, (_, page) => page)
}
