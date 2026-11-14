import type * as Mupdf from "mupdf"
import { foldCase, matchTerm, streamReadings, type RedactionTerm } from "../../../core/pdfedit/redactVerify"
import { clearField, removeAnnotationTree } from "./apply"

// Find and redact beyond the page text (one journal operation, after the marks are applied): the searched terms are
// removed from everything else that stores text. An annotation or comment that mentions a term is removed with its
// replies; a form field whose value mentions one loses the value; a link to a URI with one goes; every other string,
// name or key (bookmarks, destinations, page labels, tags, document information, attachment names) has the term
// cut out. XMP streams and attachment contents are left to Sanitize. Page content is only ever changed by marks.

function hasTerm(text: string, terms: readonly RedactionTerm[]): boolean {
	const folded = foldCase(text)

	return terms.some(term => matchTerm(text, term, folded).length > 0)
}

// The text without any match of the terms.
export function cutTerms(text: string, terms: readonly RedactionTerm[]): string {
	let out = text

	for (const term of terms) {
		const matches = matchTerm(out, term)

		for (let index = matches.length - 1; index >= 0; index--) {
			const match = matches[index]

			if (match !== undefined) out = out.slice(0, match.start) + out.slice(match.end)
		}
	}

	return out
}

function stringsOf(object: Mupdf.PDFObject, depth = 0): string[] {
	if (depth > 16) return []
	if (object.isString()) return [object.asString()]
	if (object.isName()) return [object.asName()]

	const out: string[] = []

	if (object.isDictionary() || object.isArray()) {
		object.forEach((value, key) => {
			if (typeof key === "string") out.push(key)
			if (!value.isIndirect() || value.isString()) out.push(...stringsOf(value, depth + 1))
		})
	}

	return out
}

// An annotation's appearance streams, decoded.
function appearanceTexts(object: Mupdf.PDFObject): string[] {
	const texts: string[] = []

	object.get("AP").forEach(appearance => {
		const streams: Mupdf.PDFObject[] = appearance.isStream() ? [appearance] : []

		if (!appearance.isStream() && appearance.isDictionary()) appearance.forEach(state => streams.push(state))

		for (const stream of streams) if (stream.isStream()) texts.push(...streamReadings(stream.readStream().asUint8Array()))
	})

	return texts
}

function mentions(object: Mupdf.PDFObject, terms: readonly RedactionTerm[], keys: readonly string[]): boolean {
	return [...keys.flatMap(key => stringsOf(object.get(key))), ...appearanceTexts(object)].some(text => hasTerm(text, terms))
}

// Replaces every string, name and key containing a term in a direct object tree; indirect children are visited as
// objects of their own.
function cutIn(document: Mupdf.PDFDocument, object: Mupdf.PDFObject, terms: readonly RedactionTerm[], depth: number): void {
	if (depth > 64 || !(object.isDictionary() || object.isArray())) return

	const replacements: [string | number, Mupdf.PDFObject][] = []
	const renamed: [string, string, Mupdf.PDFObject][] = []

	object.forEach((value, key) => {
		if (typeof key === "string" && hasTerm(key, terms)) renamed.push([key, cutTerms(key, terms), value])
		if (value.isIndirect()) return
		if (value.isString() && hasTerm(value.asString(), terms))
			replacements.push([key, document.newString(cutTerms(value.asString(), terms))])
		else if (value.isName() && hasTerm(value.asName(), terms))
			replacements.push([key, document.newName(cutTerms(value.asName(), terms))])
		else cutIn(document, value, terms, depth + 1)
	})

	for (const [key, value] of replacements) object.put(key, value)

	for (const [from, to, value] of renamed) {
		object.delete(from)
		if (to.length > 0) object.put(to, value)
	}
}

// Removes the terms outside page content. Returns the pages whose annotations or fields changed.
export function scrubTermsForRedaction(document: Mupdf.PDFDocument, terms: readonly RedactionTerm[]): number[] {
	if (terms.length === 0) return []

	const pages = new Set<number>()
	const contents = new Set<number>()

	for (let index = 0; index < document.countPages(); index++) {
		const page = document.loadPage(index)
		const object = page.getObject()
		const parts = object.get("Contents")

		if (parts.isArray()) parts.forEach(part => contents.add(part.asIndirect()))
		else contents.add(parts.asIndirect())

		for (const link of page.getLinks()) {
			if (hasTerm(link.getURI(), terms)) {
				page.deleteLink(link)
				pages.add(index)
			}
		}

		for (const widget of page.getWidgets()) {
			const field = widget.getObject()

			if (!mentions(field, terms, ["V", "DV", "Parent"])) continue

			for (const other of clearField(document, field)) pages.add(other)

			field.delete("AP")
			pages.add(index)
		}

		for (const annotation of page.getAnnotations()) {
			const type = annotation.getType()

			if (
				type === "Redact" ||
				type === "Popup" ||
				!mentions(annotation.getObject(), terms, ["Contents", "RC", "T", "Subj", "NM", "A"])
			)
				continue
			if (!page.getAnnotations().some(current => current.getObject().asIndirect() === annotation.getObject().asIndirect())) continue

			removeAnnotationTree(document, page, annotation)
			pages.add(index)
		}

		page.destroy()
	}

	const trailer = document.getTrailer()
	const info = trailer.get("Info")
	// The encryption dictionary and the file identifier are binary, never text.
	const encryption = trailer.get("Encrypt").asIndirect()

	if (info.isDictionary() && !info.isIndirect()) cutIn(document, info, terms, 0)

	for (let number = 1; number < document.countObjects(); number++) {
		if (contents.has(number) || number === encryption) continue

		const reference = document.newIndirect(number)
		const object = reference.resolve()

		if (object.isString() && hasTerm(object.asString(), terms))
			reference.writeObject(document.newString(cutTerms(object.asString(), terms)))
		else cutIn(document, object, terms, 0)
	}

	return [...pages].sort((left, right) => left - right)
}
