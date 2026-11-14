import type { PDFDocument, PDFObject } from "mupdf"

// Document-level form facts: XFA (hybrid forms are filled through their AcroForm and lose the XFA packet on the
// first save; XFA-only forms are view-only) and the scripts a form relies on (they never run here, so calculated
// fields do not update: the notice says so).

// "hybrid": XFA beside AcroForm fields (fillable here); "xfaOnly": XFA without AcroForm fields (view only).
export type PdfXfaKind = "none" | "hybrid" | "xfaOnly"

export interface PdfFormScripts {
	// /AA /C on a field, or a non-empty AcroForm /CO.
	readonly calculate: boolean
	// /AA /F.
	readonly format: boolean
	// /AA /V.
	readonly validate: boolean
	// /AA /K.
	readonly keystroke: boolean
}

const MAX_DEPTH = 32
const MAX_NODES = 20_000

function deref(object: PDFObject): PDFObject {
	return object.isIndirect() ? object.resolve() : object
}

function acroForm(document: PDFDocument): PDFObject {
	return deref(document.getTrailer().get("Root", "AcroForm"))
}

function hasFields(form: PDFObject): boolean {
	const fields = deref(form.get("Fields"))

	return fields.isArray() && fields.length > 0
}

export function pdfXfaKind(document: PDFDocument): PdfXfaKind {
	const form = acroForm(document)

	if (!form.isDictionary() || deref(form.get("XFA")).isNull()) return "none"

	return hasFields(form) ? "hybrid" : "xfaOnly"
}

// Deletes the XFA packet (and the "needs rendering" flag that only XFA viewers honour) so the AcroForm values are what
// every viewer shows. True when something was removed. Done right before the first save of a hybrid form, after the
// user confirmed.
export function removeXfa(document: PDFDocument): boolean {
	const form = acroForm(document)

	if (!form.isDictionary() || deref(form.get("XFA")).isNull()) return false

	form.delete("XFA")

	const root = deref(document.getTrailer().get("Root"))

	if (!deref(root.get("NeedsRendering")).isNull()) root.delete("NeedsRendering")

	return true
}

// Which script triggers the form's fields declare (walks the field tree once, bounded).
export function pdfFormScripts(document: PDFDocument): PdfFormScripts {
	const form = acroForm(document)
	const found = { calculate: false, format: false, validate: false, keystroke: false }

	if (!form.isDictionary()) return found

	const order = deref(form.get("CO"))

	if (order.isArray() && order.length > 0) found.calculate = true

	const seen = new Set<number>()
	let visited = 0
	const visit = (node: PDFObject, depth: number): void => {
		if (depth > MAX_DEPTH || visited++ > MAX_NODES) return
		if (node.isIndirect()) {
			if (seen.has(node.asIndirect())) return

			seen.add(node.asIndirect())
		}

		const dict = deref(node)

		if (!dict.isDictionary()) return

		const actions = deref(dict.get("AA"))

		if (actions.isDictionary()) {
			if (!actions.get("C").isNull()) found.calculate = true
			if (!actions.get("F").isNull()) found.format = true
			if (!actions.get("V").isNull()) found.validate = true
			if (!actions.get("K").isNull()) found.keystroke = true
		}

		const kids = deref(dict.get("Kids"))

		if (kids.isArray()) for (let index = 0; index < kids.length; index++) visit(kids.get(index), depth + 1)
	}

	const fields = deref(form.get("Fields"))

	if (fields.isArray()) for (let index = 0; index < fields.length; index++) visit(fields.get(index), 0)

	return found
}

// Whether the scripts notice applies: calculate, format or validate actions (a keystroke filter alone changes nothing
// a reader sees).
export function hasFormScripts(document: PDFDocument): boolean {
	const scripts = pdfFormScripts(document)

	return scripts.calculate || scripts.format || scripts.validate
}
