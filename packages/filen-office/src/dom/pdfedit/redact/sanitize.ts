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

// Every object of the document, resolved, and the trailer, with its object number (0 for the trailer).
function forEachObject(document: Mupdf.PDFDocument, visit: (object: Mupdf.PDFObject, number: number) => void): void {
	visit(document.getTrailer(), 0)

	for (let number = 1; number < document.countObjects(); number++) visit(document.newIndirect(number).resolve(), number)
}

// ——— Dictionaries whose keys are names ———

// A resources dictionary (/Resources of a page, form, pattern or Type 3 font; /DR of the form), or a dictionary whose
// keys are names a producer or person chose: the resource maps of a resources dictionary (/Font, /XObject, …) and
// the name-keyed maps /Dests, /RoleMap and /ClassMap. In those, /AA or /Metadata is the name of an entry, not the
// format's key: the key rules of sanitize and the verifier skip them (and still look at their values).
export type PdfDictRole = "resources" | "names" | null

const RESOURCE_MAPS: ReadonlySet<string> = new Set(["Font", "XObject", "ExtGState", "ColorSpace", "Pattern", "Shading", "Properties"])
const NAME_MAPS: ReadonlySet<string> = new Set(["Dests", "RoleMap", "ClassMap"])

// What the value stored under `key` of a dictionary in `role` is.
export function childDictRole(role: PdfDictRole, key: string | number): PdfDictRole {
	if (typeof key !== "string" || role === "names") return null
	if (role === "resources" && RESOURCE_MAPS.has(key)) return "names"
	if (key === "Resources" || key === "DR") return "resources"

	return NAME_MAPS.has(key) ? "names" : null
}

// Calls `visit` for every direct dictionary in the object (stream dictionaries included), depth first, with its role;
// `reference` for every indirect object it refers to, with the role the entry gives it.
function walkDicts(
	object: Mupdf.PDFObject,
	role: PdfDictRole,
	visit: (dict: Mupdf.PDFObject, role: PdfDictRole) => void,
	reference: (object: Mupdf.PDFObject, role: PdfDictRole) => void,
	depth = 0
): void {
	if (depth > 64) return
	if (object.isDictionary()) {
		visit(object, role)
		object.forEach((value, key) => {
			if (value.isIndirect()) reference(value, childDictRole(role, key))
			else walkDicts(value, childDictRole(role, key), visit, reference, depth + 1)
		})
	} else if (object.isArray()) {
		object.forEach(value => {
			if (value.isIndirect()) reference(value, null)
			else walkDicts(value, null, visit, reference, depth + 1)
		})
	}
}

const ignore = (): void => undefined

// The role of every indirect dictionary that has one, from the entries referring to it: resources dictionaries first,
// then their resource maps.
export function indirectDictRoles(document: Mupdf.PDFDocument): ReadonlyMap<number, PdfDictRole> {
	const roles = new Map<number, PdfDictRole>()
	const resources: number[] = []
	const note = (object: Mupdf.PDFObject, role: PdfDictRole): void => {
		const number = object.asIndirect()

		if (role === null || roles.has(number)) return

		roles.set(number, role)

		if (role === "resources") resources.push(number)
	}

	forEachObject(document, object => {
		walkDicts(object, null, ignore, note)
	})

	for (let number = resources.pop(); number !== undefined; number = resources.pop())
		walkDicts(document.newIndirect(number).resolve(), "resources", ignore, note)

	return roles
}

// Calls `visit` for every dictionary of the document with its role.
export function forEachDocumentDict(document: Mupdf.PDFDocument, visit: (dict: Mupdf.PDFObject, role: PdfDictRole) => void): void {
	const roles = indirectDictRoles(document)

	forEachObject(document, (object, number) => {
		walkDicts(object, roles.get(number) ?? null, visit, ignore)
	})
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
	forEachDocumentDict(document, (dict, role) => {
		// The keys of a resources map or name map are names, not the format's keys.
		if (role === "names") return

		for (const key of DROPPED_KEYS) if (!dict.get(key).isNull()) dict.delete(key)

		const action = dict.get("A")

		// Struct elements use /A for attributes; only action dictionaries (with /S) are actions.
		if (action.isDictionary() && !action.get("S").isNull() && !isNavigation(action)) dict.delete("A")
	})

	return pages
}
