import type * as Mupdf from "mupdf"
import { fieldEditable, type PdfSignatureState } from "../../core/pdfedit/signaturePolicy"
import type { PdfFormState, PdfRect, PdfWidgetSummary, PdfWidgetType } from "../../core/pdfedit/state"
import type { PdfFieldLock } from "../../core/pdfsign/policy"
import { at, certificationOf, collectFields, deref, locksOf, name, num, ref, signatureFieldsOf } from "./fields"
import { describeWidget, type PdfFieldKind } from "./fillSign/fields"
import { hasFormScripts, pdfXfaKind } from "./fillSign/forms"

// What the editor reports of a document's form and signatures, read through MuPDF: the widgets of a page as the page
// shows them, the form's scripts and XFA, the signatures' locks. Rectangles are flipped to the page's bottom-left
// origin (state.ts).

const TYPES: Readonly<Record<PdfFieldKind, PdfWidgetType>> = {
	text: "text",
	checkbox: "checkbox",
	radio: "radio",
	combo: "combobox",
	list: "listbox",
	button: "button",
	signature: "signature"
}

// A rectangle of MuPDF's page space (origin top left) in the page's bottom-left user space.
export function flipRect(rect: Readonly<Mupdf.Rect>, bounds: Readonly<Mupdf.Rect>): PdfRect {
	return [rect[0] - bounds[0], bounds[3] - rect[3], rect[2] - bounds[0], bounds[3] - rect[1]]
}

// A widget as the page holds it: the Fill & Sign block's reading (fillSign/fields.ts) in bottom-left user space, with
// whether a signature locks its field.
export function widgetSummary(
	widget: Mupdf.PDFWidget,
	page: number,
	bounds: Mupdf.Rect,
	signatures: PdfSignatureState
): PdfWidgetSummary | null {
	if (!widget.getObject().isIndirect()) return null

	const field = describeWidget(widget, page)

	return {
		id: field.widget,
		page,
		rect: flipRect(field.rect, bounds),
		type: TYPES[field.kind],
		field: field.name,
		label: field.label,
		value: field.value,
		selected: field.selected,
		onState: field.onState,
		options: field.options,
		maxLength: field.maxLength,
		readOnly: field.readOnly,
		required: field.required,
		multiline: field.multiline,
		password: field.password,
		comb: field.comb,
		multiSelect: field.multiSelect,
		editable: field.editable,
		locked: !fieldEditable(signatures, field.name)
	}
}

// Bounds of the structure tree walk (a hostile document's tree may be huge or cyclic).
const MAX_STRUCTURE_NODES = 200_000

// The annotations the structure tree refers to (OBJR), by object number, in the order the tree reaches them: the tab
// order of a page whose /Tabs is /S. Read once per open document.
const structureOrders = new WeakMap<Mupdf.PDFDocument, ReadonlyMap<number, number>>()

function structureOrder(document: Mupdf.PDFDocument): ReadonlyMap<number, number> {
	const cached = structureOrders.get(document)

	if (cached !== undefined) return cached

	const order = new Map<number, number>()
	const seen = new Set<number>()
	const stack: Mupdf.PDFObject[] = [ref(document.getTrailer(), "Root", "StructTreeRoot", "K")]
	let visited = 0

	while (stack.length > 0 && visited++ < MAX_STRUCTURE_NODES) {
		const node = stack.pop()

		if (node === undefined || node.isNull()) continue
		if (node.isIndirect()) {
			if (seen.has(node.asIndirect())) continue

			seen.add(node.asIndirect())
		}

		const value = deref(node)

		if (value.isArray()) {
			for (let index = value.length - 1; index >= 0; index--) stack.push(ref(value, index))

			continue
		}

		if (!value.isDictionary()) continue

		const target = num(ref(value, "Obj"))

		if (name(ref(value, "Type")) === "OBJR" && target !== null) {
			if (!order.has(target)) order.set(target, order.size)

			continue
		}

		stack.push(ref(value, "K"))
	}

	structureOrders.set(document, order)

	return order
}

// The widgets of a loaded page in its tab order: the annotation order, or the structure order when the page's /Tabs
// is /S (PDF 32000-1 §12.5 Table 30; widgets the structure does not reach keep their order after the others).
export function pageWidgets(
	document: Mupdf.PDFDocument,
	page: Mupdf.PDFPage,
	index: number,
	signatures: PdfSignatureState
): PdfWidgetSummary[] {
	const bounds = page.getBounds()
	const widgets: PdfWidgetSummary[] = []

	for (const widget of page.getWidgets()) {
		const summary = widgetSummary(widget, index, bounds, signatures)

		if (summary !== null) widgets.push(summary)
	}

	if (name(ref(page.getObject(), "Tabs")) !== "S" || widgets.length < 2) return widgets

	const order = structureOrder(document)
	const rank = (widget: PdfWidgetSummary): number => order.get(widget.id) ?? Number.MAX_SAFE_INTEGER

	// A stable sort: unreached widgets keep their annotation order.
	return widgets.sort((a, b) => rank(a) - rank(b))
}

// The form's size and the honest limits filling it has: its scripts (fillSign/forms.ts, which never run here) and XFA.
export function formState(document: Mupdf.PDFDocument): PdfFormState {
	return { fields: collectFields(document).fields.length, scripts: hasFormScripts(document), xfa: xfaState(document) }
}

// The form's XFA as the snapshot reports it (cheap: two dictionary reads; it changes when the XFA is removed).
export function xfaState(document: Mupdf.PDFDocument): PdfFormState["xfa"] {
	const kind = pdfXfaKind(document)

	return kind === "xfaOnly" ? "only" : kind
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
