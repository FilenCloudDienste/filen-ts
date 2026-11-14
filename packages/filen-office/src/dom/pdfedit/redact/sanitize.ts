import type * as Mupdf from "mupdf"
import { removeHiddenContent, type OcVisibility } from "./content"

// Sanitize, the optional last step of applying redactions (one journal operation): the document information
// dictionary, every XMP metadata stream (document, pages, images, fonts, anything), attachments, JavaScript and every
// action but in-document navigation, content in hidden layers, and private page-piece data. Saving with a full
// rewrite then drops the unreferenced objects and every earlier revision.

const DROPPED_KEYS = ["Metadata", "PieceInfo", "AA", "AF", "Thumb"]
// Annotations that exist to carry an attachment, media or an action.
const DROPPED_ANNOTATIONS = new Set(["FileAttachment", "Sound", "Movie", "Screen", "RichMedia", "3D"])

function isNavigation(action: Mupdf.PDFObject): boolean {
	// A destination array, or GoTo with a destination inside this document.
	return action.isArray() || (action.isDictionary() && action.get("S").asName() === "GoTo" && action.get("Next").isNull())
}

// Whether an optional content group or membership dictionary is visible in the document's default configuration.
export function ocVisibility(document: Mupdf.PDFDocument): OcVisibility {
	const config = document.getTrailer().get("Root", "OCProperties", "D")
	const off = new Set<number>()
	const on = new Set<number>()
	const read = (key: string): Mupdf.PDFObject | null => (config.isDictionary() ? config.get(key) : null)
	const baseOff = read("BaseState")?.asName() === "OFF"
	const collect = (list: Mupdf.PDFObject | null, into: Set<number>): void => {
		if (list?.isArray() === true) for (let index = 0; index < list.length; index++) into.add(list.get(index).asIndirect())
	}

	collect(read("OFF"), off)
	collect(read("ON"), on)

	const group = (ocg: Mupdf.PDFObject): boolean => {
		const number = ocg.asIndirect()

		return baseOff ? on.has(number) : !off.has(number)
	}
	const expression = (node: Mupdf.PDFObject, depth: number): boolean => {
		if (depth > 16) return true
		if (!node.isArray()) return node.isDictionary() ? group(node) : true

		const operator = node.get(0).asName()
		const operands: boolean[] = []

		for (let index = 1; index < node.length; index++) operands.push(expression(node.get(index), depth + 1))

		if (operator === "Not") return !(operands[0] ?? true)
		if (operator === "Or") return operands.some(Boolean)

		return operands.every(Boolean)
	}

	return properties => {
		const type = properties.get("Type").asName()

		if (type === "OCG") return group(properties)
		if (type !== "OCMD") return true

		const ve = properties.get("VE")

		if (ve.isArray()) return expression(ve, 0)

		const ocgs = properties.get("OCGs")
		const states: boolean[] = []

		if (ocgs.isArray()) for (let index = 0; index < ocgs.length; index++) states.push(group(ocgs.get(index)))
		else if (ocgs.isDictionary()) states.push(group(ocgs))

		if (states.length === 0) return true

		switch (properties.get("P").asName()) {
			case "AllOn":
				return states.every(Boolean)
			case "AnyOff":
				return states.some(state => !state)
			case "AllOff":
				return states.every(state => !state)
			default:
				return states.some(Boolean)
		}
	}
}

// Every object of the document, resolved, and the trailer.
function forEachObject(document: Mupdf.PDFDocument, visit: (object: Mupdf.PDFObject) => void): void {
	visit(document.getTrailer())

	for (let number = 1; number < document.countObjects(); number++) visit(document.newIndirect(number).resolve())
}

// Calls `visit` for every dictionary in the object (stream dictionaries included), depth first.
function forEachDict(object: Mupdf.PDFObject, visit: (dict: Mupdf.PDFObject) => void, depth = 0): void {
	if (depth > 64 || object.isIndirect()) return
	if (object.isDictionary()) {
		visit(object)
		object.forEach(value => {
			forEachDict(value, visit, depth + 1)
		})
	} else if (object.isArray()) {
		object.forEach(value => {
			forEachDict(value, visit, depth + 1)
		})
	}
}

// Sanitizes the document. Returns the pages whose content or annotations changed.
export function sanitizeForRedaction(document: Mupdf.PDFDocument): number[] {
	const pages: number[] = []
	const trailer = document.getTrailer()
	const root = trailer.get("Root")
	const visible = ocVisibility(document)

	trailer.delete("Info")

	const names = root.get("Names")

	if (names.isDictionary()) for (const key of ["JavaScript", "EmbeddedFiles"]) names.delete(key)

	for (const key of ["Collection", "URI"]) root.delete(key)

	if (!isNavigation(root.get("OpenAction"))) root.delete("OpenAction")

	const form = root.get("AcroForm")

	if (form.isDictionary()) form.delete("XFA")

	// Hidden layers first: they decide which annotations are left to clean.
	const done = new Set<number>()

	for (let index = 0; index < document.countPages(); index++) {
		const page = document.loadPage(index)
		let changed = removeHiddenContent(document, page, visible, done)

		for (const annotation of page.getAnnotations()) {
			if (DROPPED_ANNOTATIONS.has(annotation.getType())) {
				page.deleteAnnotation(annotation)
				changed = true
			}
		}

		for (const link of page.getLinks()) {
			if (link.isExternal()) {
				page.deleteLink(link)
				changed = true
			}
		}

		page.destroy()

		if (changed) pages.push(index)
	}

	// Then every dictionary anywhere: metadata, page pieces, additional actions, associated files, thumbnails and
	// every action that is not navigation (JavaScript, launch, submit, URI, named actions, media).
	forEachObject(document, object => {
		forEachDict(object, dict => {
			for (const key of DROPPED_KEYS) if (!dict.get(key).isNull()) dict.delete(key)

			const action = dict.get("A")

			// Struct elements use /A for attributes; only action dictionaries (with /S) are actions.
			if (action.isDictionary() && !action.get("S").isNull() && !isNavigation(action)) dict.delete("A")
		})
	})

	return pages
}
