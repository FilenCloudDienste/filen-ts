import type * as Mupdf from "mupdf"
import { matchedTerm, matchTerm, streamReadings, type RedactionTerm } from "../../../core/pdfedit/redactVerify"
import { clearField, removeAnnotationTree } from "./apply"
import { appearanceStreams } from "./content"
import { appearanceStates, isUserNameValue, STATE_KEYS, userNames } from "./structure"

// Find and redact beyond the page text (one journal operation, after the marks are applied): the searched terms are
// removed from everything else that stores text. An annotation or comment that mentions a term is removed with its
// replies; a form field whose value or button state mentions one loses the value; a link to a URI with one goes;
// every other string, and every name a person chose (structure.ts userNames: destinations, tags, custom document
// information), has the term cut out. The format's own names and keys are never changed. XMP streams and attachment
// contents are left to Sanitize. Page content is only ever changed by marks.

function hasTerm(text: string, terms: readonly RedactionTerm[]): boolean {
	return matchedTerm(text, terms) !== null
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

// The strings of a direct object tree, and the names in it a person chose.
function textsOf(object: Mupdf.PDFObject, depth = 0): string[] {
	if (depth > 16) return []
	if (object.isString()) return [object.asString()]

	const out: string[] = []

	if (object.isDictionary() || object.isArray()) {
		object.forEach((value, key) => {
			if (value.isName()) {
				if (isUserNameValue(object, key, value.asName())) out.push(value.asName())
			} else if (!value.isIndirect() || value.isString()) out.push(...textsOf(value, depth + 1))
		})
	}

	return out
}

// Whether an annotation's appearance streams hold a term, decoding one reading at a time and stopping at the first match.
function appearanceMentions(object: Mupdf.PDFObject, terms: readonly RedactionTerm[]): boolean {
	for (const stream of appearanceStreams(object)) {
		for (const reading of streamReadings(stream.readStream().asUint8Array())) if (hasTerm(reading, terms)) return true
	}

	return false
}

function mentions(object: Mupdf.PDFObject, terms: readonly RedactionTerm[], keys: readonly string[]): boolean {
	return keys.some(key => textsOf(object.get(key)).some(text => hasTerm(text, terms))) || appearanceMentions(object, terms)
}

// Whether a widget's field holds a term in a value (up its parent chain) or a button state chosen by a person.
function fieldMentions(widget: Mupdf.PDFObject, terms: readonly RedactionTerm[]): boolean {
	let field = widget

	for (let depth = 0; depth < 32 && field.isDictionary(); depth++) {
		for (const key of ["V", "DV"]) {
			const value = field.get(key)

			if (value.isName()) {
				if (isUserNameValue(field, key, value.asName()) && hasTerm(value.asName(), terms)) return true
			} else if (textsOf(value).some(text => hasTerm(text, terms))) return true
		}

		field = field.get("Parent")
	}

	const state = widget.get("AS")

	if (state.isName() && isUserNameValue(widget, "AS", state.asName()) && hasTerm(state.asName(), terms)) return true

	for (const states of appearanceStates(widget)) {
		let found = false

		states.forEach((_, key) => {
			if (!found && typeof key === "string" && !STATE_KEYS.has(key) && hasTerm(key, terms)) found = true
		})

		if (found) return true
	}

	return appearanceMentions(widget, terms)
}

// Cuts the terms out of every string of a direct object tree, and out of the names in it a person chose (a name cut to
// nothing goes with its entry); indirect children are visited as objects of their own.
function cutIn(document: Mupdf.PDFDocument, object: Mupdf.PDFObject, terms: readonly RedactionTerm[], depth: number): void {
	if (depth > 64 || !(object.isDictionary() || object.isArray())) return

	const replacements: [string | number, Mupdf.PDFObject | null][] = []

	object.forEach((value, key) => {
		if (value.isIndirect()) return
		if (value.isString()) {
			if (hasTerm(value.asString(), terms)) replacements.push([key, document.newString(cutTerms(value.asString(), terms))])
		} else if (value.isName()) {
			if (isUserNameValue(object, key, value.asName()) && hasTerm(value.asName(), terms)) {
				const cut = cutTerms(value.asName(), terms)

				replacements.push([key, cut.length > 0 ? document.newName(cut) : null])
			}
		} else cutIn(document, value, terms, depth + 1)
	})

	// Removals from the end, so array indices stay valid.
	for (let index = replacements.length - 1; index >= 0; index--) {
		const replacement = replacements[index]

		if (replacement === undefined) continue

		const [key, value] = replacement

		if (value === null) object.delete(key)
		else object.put(key, value)
	}
}

// Renames the keys of a dictionary that hold a term (but for `fixed` ones), keeping each value. A key cut to nothing
// goes with its value; one cut to a key the dictionary already has gets a free name next to it.
function cutKeys(dict: Mupdf.PDFObject, fixed: ReadonlySet<string>, terms: readonly RedactionTerm[]): void {
	const renamed: [string, string][] = []
	const kept = new Set<string>()

	dict.forEach((_, key) => {
		if (typeof key !== "string") return
		if (!fixed.has(key) && hasTerm(key, terms)) renamed.push([key, cutTerms(key, terms)])
		else kept.add(key)
	})

	for (const [from, to] of renamed) {
		const value = dict.get(from)

		dict.delete(from)

		if (to.length === 0) continue

		let name = to

		for (let suffix = 2; kept.has(name); suffix++) name = `${to} ${String(suffix)}`

		kept.add(name)
		dict.put(name, value)
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

			if (!fieldMentions(field, terms)) continue

			for (const other of clearField(document, field)) pages.add(other)

			field.delete("AP")

			if (field.get("AS").isName()) field.put("AS", document.newName("Off"))

			pages.add(index)
		}

		// Annotations already removed with an earlier one's replies.
		const removed = new Set<number>()

		// A copy: deleting an annotation splices MuPDF's cached list.
		for (const annotation of [...page.getAnnotations()]) {
			// A removed annotation no longer answers getType.
			if (removed.has(annotation.getObject().asIndirect())) continue

			const type = annotation.getType()

			if (type === "Redact" || type === "Popup") continue
			if (!mentions(annotation.getObject(), terms, ["Contents", "RC", "T", "Subj", "NM", "A"])) continue

			for (const number of removeAnnotationTree(document, page, annotation)) removed.add(number)

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

		// A cross-reference stream's dictionary is the trailer (the file identifier, a direct encryption dictionary).
		if (object.isDictionary() && object.get("Type").asName() === "XRef") continue
		if (object.isString() && hasTerm(object.asString(), terms))
			reference.writeObject(document.newString(cutTerms(object.asString(), terms)))
		else cutIn(document, object, terms, 0)
	}

	// After the strings: a renamed key keeps its value as already cut.
	const chosen = userNames(document)

	for (let index = chosen.values.length - 1; index >= 0; index--) {
		const slot = chosen.values[index]

		if (slot === undefined) continue

		const value = slot.holder.get(slot.key)

		if (!value.isName() || !hasTerm(value.asName(), terms)) continue

		const cut = cutTerms(value.asName(), terms)

		if (cut.length > 0) slot.holder.put(slot.key, document.newName(cut))
		else if (slot.empty !== undefined) slot.holder.put(slot.key, document.newName(slot.empty))
		else slot.holder.delete(slot.key)
	}

	for (const { dict, fixed } of chosen.keys) cutKeys(dict, fixed, terms)

	return [...pages].sort((left, right) => left - right)
}
