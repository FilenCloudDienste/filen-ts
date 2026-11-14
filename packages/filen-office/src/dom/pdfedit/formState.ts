import type * as Mupdf from "mupdf"
import { fieldEditable, type PdfSignatureState } from "../../core/pdfedit/signaturePolicy"
import type { PdfFormState, PdfRect, PdfWidgetSummary, PdfWidgetType } from "../../core/pdfedit/state"
import type { PdfFieldLock } from "../../core/pdfsign/policy"
import { at, certificationOf, collectFields, deref, locksOf, MAX_FIELD_DEPTH, num, ref, signatureFieldsOf, text } from "./fields"

// What the editor reports of a document's form and signatures, read through MuPDF: the widgets of a page as the page
// shows them, the form's scripts and XFA, the signatures' locks. Rectangles are flipped to the page's bottom-left
// origin (state.ts).

// Field flags (PDF 32000-1 Tables 221, 226, 228, 230).
const FLAG = {
	readOnly: 1,
	required: 1 << 1,
	multiline: 1 << 12,
	password: 1 << 13,
	edit: 1 << 18,
	multiSelect: 1 << 21,
	comb: 1 << 24
} as const

const TYPES: Readonly<Record<string, PdfWidgetType>> = {
	text: "text",
	checkbox: "checkbox",
	radiobutton: "radio",
	combobox: "combobox",
	listbox: "listbox",
	button: "button",
	signature: "signature"
}

// Script triggers of a field or widget that would format or compute values (PDF 32000-1 Table 196).
const FIELD_SCRIPTS = ["K", "F", "V", "C"] as const

// A rectangle of MuPDF's page space (origin top left) in the page's bottom-left user space.
export function flipRect(rect: Mupdf.Rect, bounds: Mupdf.Rect): PdfRect {
	return [rect[0] - bounds[0], bounds[3] - rect[3], rect[2] - bounds[0], bounds[3] - rect[1]]
}

// The fully qualified name of the field a widget belongs to: its own /T and its parents'.
export function fieldNameOf(widget: Mupdf.PDFObject): string {
	const parts: string[] = []
	let current = deref(widget)

	for (let depth = 0; depth < MAX_FIELD_DEPTH && current.isDictionary(); depth++) {
		const partial = text(ref(current, "T"))

		if (partial !== null) parts.unshift(partial)

		current = at(current, "Parent")
	}

	return parts.join(".")
}

// A checkbox's or radio button's "on" state: the normal appearance's state other than Off.
function onStateOf(widget: Mupdf.PDFObject): string | null {
	const states = at(widget, "AP", "N")
	let on: string | null = null

	if (states.isDictionary()) {
		states.forEach((_value, key) => {
			if (on === null && key !== "Off") on = String(key)
		})
	}

	return on
}

export function widgetSummary(
	widget: Mupdf.PDFWidget,
	page: number,
	bounds: Mupdf.Rect,
	signatures: PdfSignatureState
): PdfWidgetSummary | null {
	const object = widget.getObject()
	const id = object.isIndirect() ? object.asIndirect() : null

	if (id === null) return null

	const type = TYPES[widget.getFieldType()] ?? null

	if (type === null) return null

	const flags = widget.getFieldFlags()
	const field = fieldNameOf(object)
	const choice = type === "combobox" || type === "listbox"

	return {
		id,
		page,
		rect: flipRect(widget.getRect(), bounds),
		type,
		field,
		label: widget.getLabel(),
		value: widget.getValue(),
		onState: type === "checkbox" || type === "radio" ? onStateOf(object) : null,
		options: choice ? widget.getOptions(false) : [],
		maxLength: type === "text" ? widget.getMaxLen() : 0,
		readOnly: (flags & FLAG.readOnly) !== 0,
		required: (flags & FLAG.required) !== 0,
		multiline: type === "text" && (flags & FLAG.multiline) !== 0,
		password: type === "text" && (flags & FLAG.password) !== 0,
		comb: type === "text" && (flags & FLAG.comb) !== 0,
		multiSelect: choice && (flags & FLAG.multiSelect) !== 0,
		editable: type === "combobox" && (flags & FLAG.edit) !== 0,
		locked: !fieldEditable(signatures, field)
	}
}

// The widgets of a loaded page, in the page's annotation order (the tab order without a structure tree).
export function pageWidgets(page: Mupdf.PDFPage, index: number, signatures: PdfSignatureState): PdfWidgetSummary[] {
	const bounds = page.getBounds()
	const widgets: PdfWidgetSummary[] = []

	for (const widget of page.getWidgets()) {
		const summary = widgetSummary(widget, index, bounds, signatures)

		if (summary !== null) widgets.push(summary)
	}

	return widgets
}

function hasScripts(dict: Mupdf.PDFObject): boolean {
	const actions = at(dict, "AA")

	return actions.isDictionary() && FIELD_SCRIPTS.some(key => !ref(actions, key).isNull())
}

export function formState(document: Mupdf.PDFDocument): PdfFormState {
	const root = at(document.getTrailer(), "Root")
	const acroForm = at(root, "AcroForm")
	const { fields } = collectFields(document)
	const scripts =
		!at(root, "Names", "JavaScript").isNull() ||
		fields.some(field => hasScripts(field.dict) || (field.widget !== null && hasScripts(field.widget)))
	const xfa = acroForm.isDictionary() && !ref(acroForm, "XFA").isNull()

	return { fields: fields.length, scripts, xfa: !xfa ? "none" : fields.length > 0 ? "hybrid" : "only" }
}

export function signatureState(document: Mupdf.PDFDocument): PdfSignatureState {
	const { fields } = collectFields(document)
	const signed = signatureFieldsOf(document, fields)
	const certifying = num(ref(document.getTrailer(), "Root", "Perms", "DocMDP"))
	const certifier = certifying === null ? undefined : signed.find(field => field.valueNum === certifying)
	const locks: PdfFieldLock[] = []

	for (const field of signed) locks.push(...locksOf(field))

	return { fields: signed.map(field => field.name), certification: certificationOf(document, certifier), locks }
}

export function isTagged(document: Mupdf.PDFDocument): boolean {
	const root = at(document.getTrailer(), "Root")
	const marked = at(root, "MarkInfo", "Marked")

	return marked.isBoolean() && marked.asBoolean() && at(root, "StructTreeRoot").isDictionary()
}

// The pages a field's widgets lie on (a radio group's buttons may be on several), from their /P, else `fallback`.
export function fieldPages(widget: Mupdf.PDFObject, pageOf: (pageObject: number) => number | undefined, fallback: number): number[] {
	const dict = deref(widget)
	const parent = at(dict, "Parent")
	const field = ref(dict, "T").isNull() && parent.isDictionary() ? parent : dict
	const kids = at(field, "Kids")
	const pages = new Set<number>([fallback])

	if (kids.isArray()) {
		for (let index = 0; index < kids.length; index++) {
			const pageNumber = num(ref(kids, index, "P"))
			const page = pageNumber === null ? undefined : pageOf(pageNumber)

			if (page !== undefined) pages.add(page)
		}
	}

	return [...pages].sort((a, b) => a - b)
}
