import type * as Mupdf from "mupdf"
import { coveredWords, quadBounds, rectsOverlap, type RedactionRegion, type RedactRect } from "../../../core/pdfedit/redactVerify"
import { lazyPages } from "../fields"
import type { MupdfModule } from "../protocol"
import { changedSections, markedSections, removeAlternates, removeShadings, stripSectionText } from "./content"
import { pageText } from "./find"
import { isRedaction, markOf } from "./marks"
import { stripObjectStructText, stripPageStructText } from "./structure"

// Applying a page's redaction marks (one journal operation). Text marks remove the text under their quads, image
// pixels under them, and drawings they fully cover; area and page marks remove every drawing they touch. Links and
// form fields over any mark go with their values; other annotations over a mark go when asked (the default). Text
// alternatives of redacted tagged content, thumbnails and alternate images go too. The marks are consumed.

export interface ApplyRedactionOptions {
	// Remove annotations and comments over a mark (links and form fields over a mark always go).
	readonly removeAnnotations: boolean
}

export interface AppliedRedactions {
	// What was redacted on the page, for the verifier's manifest.
	readonly regions: readonly RedactionRegion[]
	// Pages that changed: the page, and pages showing another widget of a form field whose value was removed.
	readonly pages: readonly number[]
	// The words of the page's text the marks covered (coveredWords), for the verifier's manifest.
	readonly hidden: readonly string[]
}

function overlapsAny(rect: RedactRect, regions: readonly RedactionRegion[]): boolean {
	return regions.some(region => rectsOverlap(rect, region.rect))
}

// Removes a form field's value (V, DV up its parent chain) and the appearances of its other widgets, which still
// show it. Returns the pages of those widgets.
export function clearField(document: Mupdf.PDFDocument, widget: Mupdf.PDFObject): number[] {
	const pages = new Set<number>()
	const pageIndex = lazyPages(document)
	let field = widget

	for (let depth = 0; depth < 32 && field.isDictionary(); depth++) {
		field.delete("V")
		field.delete("DV")

		const kids = field.get("Kids")

		if (kids.isArray()) {
			for (let index = 0; index < kids.length; index++) {
				const kid = kids.get(index)

				if (kid.asIndirect() === widget.asIndirect() || kid.get("AP").isNull()) continue

				kid.delete("AP")

				const page = kid.get("P")
				const at = page.isIndirect() ? pageIndex().get(page.asIndirect()) : undefined

				if (at !== undefined) pages.add(at)
			}
		}

		field = field.get("Parent")
	}

	const form = document.getTrailer().get("Root", "AcroForm")

	if (form.isDictionary()) form.put("NeedAppearances", true)

	return [...pages]
}

// Removes the widget from its field's Kids or the form's Fields, and a field left without widgets with it.
function detachWidget(document: Mupdf.PDFDocument, widget: Mupdf.PDFObject): void {
	const number = widget.asIndirect()
	const remove = (list: Mupdf.PDFObject, target: number): boolean => {
		if (!list.isArray()) return false

		for (let index = 0; index < list.length; index++) {
			if (list.get(index).asIndirect() === target) {
				list.delete(index)

				return true
			}
		}

		return false
	}
	const parent = widget.get("Parent")

	if (parent.isDictionary() && remove(parent.get("Kids"), number)) {
		if (parent.get("Kids").length === 0) detachWidget(document, parent)

		return
	}

	remove(document.getTrailer().get("Root", "AcroForm", "Fields"), number)
}

// Removes an annotation with its popup and replies (and theirs). Returns the object numbers removed.
export function removeAnnotationTree(document: Mupdf.PDFDocument, page: Mupdf.PDFPage, root: Mupdf.PDFAnnotation): ReadonlySet<number> {
	// A copy: deleting an annotation splices MuPDF's cached list.
	const annotations = [...page.getAnnotations()]
	const doomed = new Set<number>([root.getObject().asIndirect()])

	for (let grew = true; grew;) {
		grew = false

		for (const annotation of annotations) {
			const object = annotation.getObject()
			const number = object.asIndirect()

			if (doomed.has(number)) continue

			const parent = object.get("Parent").asIndirect() || object.get("IRT").asIndirect()

			if (doomed.has(parent)) {
				doomed.add(number)
				grew = true
			}
		}
	}

	for (const annotation of annotations) {
		const object = annotation.getObject()

		if (!doomed.has(object.asIndirect())) continue

		stripObjectStructText(document, object)
		page.deleteAnnotation(annotation)
	}

	return doomed
}

// Removes what lies over the marks before the content is redacted. Returns other pages that changed.
function removeOverlying(
	document: Mupdf.PDFDocument,
	page: Mupdf.PDFPage,
	regions: readonly RedactionRegion[],
	options: ApplyRedactionOptions
): number[] {
	const pages: number[] = []

	for (const link of page.getLinks()) {
		if (overlapsAny(link.getBounds(), regions)) page.deleteLink(link)
	}

	for (const widget of page.getWidgets()) {
		if (!overlapsAny(widget.getBounds(), regions)) continue

		const object = widget.getObject()

		pages.push(...clearField(document, object))
		detachWidget(document, object)
		stripObjectStructText(document, object)
		page.deleteAnnotation(widget)
	}

	if (options.removeAnnotations) {
		// Annotations already removed with an earlier one's replies.
		const removed = new Set<number>()

		for (const annotation of [...page.getAnnotations()]) {
			// A removed annotation no longer answers getType.
			if (removed.has(annotation.getObject().asIndirect())) continue

			const type = annotation.getType()

			if (type === "Redact" || type === "Popup") continue
			if (!overlapsAny(annotation.getBounds(), regions)) continue

			for (const number of removeAnnotationTree(document, page, annotation)) removed.add(number)
		}
	}

	return pages
}

// Applies the marks on `pageIndex`. Returns the redacted regions and the pages that changed (none when the page has
// no marks).
export function applyPageRedactions(
	mupdf: MupdfModule,
	document: Mupdf.PDFDocument,
	pageIndex: number,
	options: ApplyRedactionOptions
): AppliedRedactions {
	const page = document.loadPage(pageIndex)
	const marks = page.getAnnotations().filter(isRedaction)

	if (marks.length === 0) {
		page.destroy()

		return { regions: [], pages: [], hidden: [] }
	}

	const regions: RedactionRegion[] = []
	const textMarks: Mupdf.PDFAnnotation[] = []
	const areaMarks: Mupdf.PDFAnnotation[] = []

	for (const annotation of marks) {
		const mark = markOf(page, pageIndex, annotation)

		if (mark.kind === "text") {
			textMarks.push(annotation)

			for (const quad of mark.quads) regions.push({ page: pageIndex, kind: "text", rect: quadBounds(quad) })
		} else {
			areaMarks.push(annotation)
			regions.push({ page: pageIndex, kind: mark.kind, rect: mark.rect })
		}
	}

	const text = pageText(page)
	const hidden = coveredWords(
		text.text,
		text.quads.map(quad => quad !== null && overlapsAny(quadBounds(quad), regions))
	)
	const pageObject = page.getObject()
	const before = markedSections(pageObject).sections
	const others = removeOverlying(document, page, regions, options)
	const { PDFPage } = mupdf

	if (areaMarks.length > 0) {
		// MuPDF applies every Redact annotation of a page with one method, so the text marks sit this pass out
		// under another subtype.
		for (const mark of textMarks) mark.getObject().put("Subtype", document.newName("Square"))

		page.applyRedactions(true, PDFPage.REDACT_IMAGE_PIXELS, PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, PDFPage.REDACT_TEXT_REMOVE)

		for (const mark of textMarks) mark.getObject().put("Subtype", document.newName("Redact"))
	}

	if (textMarks.length > 0) {
		page.applyRedactions(true, PDFPage.REDACT_IMAGE_PIXELS, PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, PDFPage.REDACT_TEXT_REMOVE)
	}

	removeShadings(
		document,
		page,
		regions.filter(region => region.kind !== "text").map(region => region.rect)
	)

	const after = markedSections(pageObject)
	const changed = changedSections(before, after.sections)

	if (changed.length > 0) {
		stripSectionText(document, pageObject, after.operations, changed)
		stripPageStructText(
			document,
			pageObject,
			changed.length === after.sections.length && before.length !== after.sections.length
				? "all"
				: new Set(changed.flatMap(section => (section.mcid === null ? [] : [section.mcid])))
		)
	}

	removeAlternates(pageObject)
	page.destroy()

	return { regions, pages: [...new Set([pageIndex, ...others])].sort((left, right) => left - right), hidden }
}

// Applies the marks of every page that has some; one operation per page in a session, this loop for a batch.
export function applyAllRedactions(mupdf: MupdfModule, document: Mupdf.PDFDocument, options: ApplyRedactionOptions): AppliedRedactions {
	const regions: RedactionRegion[] = []
	const pages = new Set<number>()
	const hidden = new Set<string>()

	for (let index = 0; index < document.countPages(); index++) {
		const applied = applyPageRedactions(mupdf, document, index, options)

		regions.push(...applied.regions)

		for (const page of applied.pages) pages.add(page)
		for (const word of applied.hidden) hidden.add(word)
	}

	return { regions, pages: [...pages].sort((left, right) => left - right), hidden: [...hidden] }
}
