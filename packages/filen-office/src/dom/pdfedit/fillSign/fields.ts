import type { PDFDocument, PDFObject, PDFPage, PDFWidget } from "mupdf"
import type { PdfPageRect } from "../../../core/pdfedit/visualSignature"

// AcroForm fields of an open MuPDF document: what a field overlay shows (kind, value, flags, options, the /TU
// label) and the value setters a form edit applies. Each setter changes one field and regenerates the appearance
// of every widget of that field (a field may have widgets on several pages: a radio group, a repeated name); it
// returns the pages it touched so the caller re-renders only those. Journal operations are the caller's: one
// setter call is one form edit. A password field (PDF 32000-1 §12.7.4.3: its value should not be stored) is never
// filled here: its value would be written into the file. Scripts never run (the session disables JavaScript): calculated fields keep their
// last value, which pdfFormScripts reports.

export type PdfFieldKind = "text" | "checkbox" | "radio" | "combo" | "list" | "button" | "signature"

export interface PdfFieldOption {
	// What the field stores (/Opt export value).
	readonly value: string
	// What a viewer shows.
	readonly label: string
}

export interface PdfFormField {
	// The widget, by its object number (stable across journal steps, unlike its index on the page).
	readonly widget: number
	readonly page: number
	// Page space, y down (MuPDF's).
	readonly rect: PdfPageRect
	// Fully qualified field name, as the document wrote it. Never put into the DOM (dom/pdf/formWidgets.ts).
	readonly name: string
	readonly kind: PdfFieldKind
	// /TU: the field's accessible name; empty when the document gives none.
	readonly label: string
	// text/combo: the text; checkbox/radio: the field's state name ("Off" when none); list: the first selection.
	readonly value: string
	// Every selected export value (list and combo; one for a single selection, none when empty).
	readonly selected: readonly string[]
	// checkbox/radio: this widget's on state (its value when checked or chosen).
	readonly onState: string | null
	readonly readOnly: boolean
	readonly required: boolean
	readonly password: boolean
	readonly multiline: boolean
	readonly comb: boolean
	// 0: no limit.
	readonly maxLength: number
	readonly multiSelect: boolean
	// An editable combo box accepts text that is not an option.
	readonly editable: boolean
	readonly options: readonly PdfFieldOption[]
}

export type PdfFieldValue =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "checkbox"; readonly checked: boolean }
	// Chooses this widget's option of its radio group.
	| { readonly kind: "radio" }
	| { readonly kind: "choice"; readonly values: readonly string[] }

export type PdfFieldRefusal = "readOnly" | "password" | "wrongKind" | "notAnOption" | "notFound"

// A setter refused: nothing changed.
export class PdfFieldError extends Error {
	override readonly name = "PdfFieldError"
	readonly reason: PdfFieldRefusal

	constructor(reason: PdfFieldRefusal) {
		super(`form field edit refused: ${reason}`)
		this.reason = reason
	}
}

const FF_REQUIRED = 1 << 1
const FF_MULTI_SELECT = 1 << 21
const FF_EDIT = 1 << 18
// Bounds against hostile documents.
const MAX_PARENT_DEPTH = 32
const MAX_KIDS = 10_000

function kindOf(widget: PDFWidget): PdfFieldKind {
	switch (widget.getFieldType()) {
		case "text":
			return "text"
		case "checkbox":
			return "checkbox"
		case "radiobutton":
			return "radio"
		case "combobox":
			return "combo"
		case "listbox":
			return "list"
		case "signature":
			return "signature"
		default:
			return "button"
	}
}

function deref(object: PDFObject): PDFObject {
	return object.isIndirect() ? object.resolve() : object
}

function stringOf(object: PDFObject): string | null {
	const value = deref(object)

	return value.isString() ? value.asString() : value.isName() ? value.asName() : null
}

// The widget's on state: the name of its normal appearance that is not Off.
function onStateOf(widget: PDFWidget): string | null {
	const normal = deref(widget.getObject().get("AP", "N"))
	let state: string | null = null

	if (normal.isDictionary()) {
		normal.forEach((_value, key) => {
			if (state === null && typeof key === "string" && key !== "Off") state = key
		})
	}

	return state
}

// The terminal field a widget belongs to: the widget itself when it carries a name, else the nearest named parent.
// Kept as the reference the document holds (an indirect object), so its kids can be told apart by number.
function fieldOf(widget: PDFObject): PDFObject {
	let current = widget

	for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
		if (!deref(current).get("T").isNull()) return current

		const parent = deref(current).get("Parent")

		if (!deref(parent).isDictionary()) return current

		current = parent
	}

	return current
}

// Every widget object of the field `widget` belongs to (itself included), as object numbers.
function siblingWidgets(widget: PDFObject): number[] {
	const field = fieldOf(widget)
	const numbers: number[] = []
	const visit = (node: PDFObject, depth: number): void => {
		const kids = deref(deref(node).get("Kids"))

		if (!kids.isArray()) {
			if (node.isIndirect()) numbers.push(node.asIndirect())

			return
		}

		for (let index = 0; index < kids.length && numbers.length < MAX_KIDS; index++) {
			const kid = kids.get(index)

			if (depth < MAX_PARENT_DEPTH) visit(kid, depth + 1)
		}
	}

	visit(field, 0)

	return numbers
}

function selectedValues(widget: PDFWidget): string[] {
	const value = deref(deref(fieldOf(widget.getObject())).getInheritable("V"))

	if (value.isArray()) {
		const values: string[] = []

		for (let index = 0; index < value.length; index++) {
			const item = stringOf(value.get(index))

			if (item !== null) values.push(item)
		}

		return values
	}

	const single = stringOf(value)

	return single === null || single === "" ? [] : [single]
}

function optionsOf(widget: PDFWidget): PdfFieldOption[] {
	const values = widget.getOptions(true)
	const labels = widget.getOptions(false)

	return values.map((value, index) => ({ value, label: labels[index] ?? value }))
}

function rectOf(widget: PDFWidget): PdfPageRect {
	const [x0, y0, x1, y1] = widget.getRect()

	return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

export function describeWidget(widget: PDFWidget, page: number): PdfFormField {
	const kind = kindOf(widget)
	const flags = widget.getFieldFlags()
	const choice = kind === "combo" || kind === "list"
	const selected = choice ? selectedValues(widget) : []
	const button = kind === "checkbox" || kind === "radio"
	// A button without a value (a cleared form) reads as Off, as viewers show it.
	const value = choice ? (selected[0] ?? "") : button ? widget.getValue() || "Off" : widget.getValue()

	return {
		widget: widget.getObject().asIndirect(),
		page,
		rect: rectOf(widget),
		name: widget.getName(),
		kind,
		label: widget.getLabel(),
		value,
		selected,
		onState: button ? onStateOf(widget) : null,
		readOnly: widget.isReadOnly(),
		required: (flags & FF_REQUIRED) !== 0,
		password: kind === "text" && widget.isPassword(),
		multiline: kind === "text" && widget.isMultiline(),
		comb: kind === "text" && widget.isComb(),
		maxLength: kind === "text" ? Math.max(0, widget.getMaxLen()) : 0,
		multiSelect: kind === "list" && (flags & FF_MULTI_SELECT) !== 0,
		editable: kind === "combo" && (flags & FF_EDIT) !== 0,
		options: choice ? optionsOf(widget) : []
	}
}

// The page's form fields in widget order (the document's tab order on a page without /Tabs).
export function readPageFields(page: PDFPage, pageIndex: number): PdfFormField[] {
	return page.getWidgets().map(widget => describeWidget(widget, pageIndex))
}

function findWidget(page: PDFPage, objectNumber: number): PDFWidget | null {
	return page.getWidgets().find(widget => widget.getObject().asIndirect() === objectNumber) ?? null
}

// Page index by page object number, built only when a field has widgets beyond the page being edited.
function pageIndex(document: PDFDocument, pageObject: PDFObject): number | null {
	if (!pageObject.isIndirect()) return null

	const target = pageObject.asIndirect()
	const count = document.countPages()

	for (let index = 0; index < count; index++) {
		const candidate = document.findPage(index)

		if (candidate.isIndirect() && candidate.asIndirect() === target) return index
	}

	return null
}

// Regenerates the appearance of every widget of `widget`'s field; the pages touched, `pageIndex0` first.
function refreshField(document: PDFDocument, page: PDFPage, pageIndex0: number, widget: PDFWidget): number[] {
	const pages = new Set<number>([pageIndex0])
	const own = widget.getObject().asIndirect()

	widget.update()

	for (const number of siblingWidgets(widget.getObject())) {
		if (number === own) continue

		const sibling = document.newIndirect(number).resolve()
		const index = pageIndex(document, sibling.get("P"))

		if (index === null) continue

		const target = index === pageIndex0 ? page : document.loadPage(index)
		const other = findWidget(target, number)

		if (other !== null) {
			other.update()
			pages.add(index)
		}
	}

	return [...pages]
}

// Text clipped to the field's maximum length (code points, so a surrogate pair is never split); a single-line field
// keeps its first line.
export function clipFieldText(field: Pick<PdfFormField, "maxLength" | "multiline">, text: string): string {
	const single = field.multiline ? text.replace(/\r\n?/gu, "\n") : (text.split(/\r\n?|\n/u)[0] ?? "")

	if (field.maxLength <= 0) return single

	return [...single].slice(0, field.maxLength).join("")
}

function setChoice(document: PDFDocument, widget: PDFWidget, field: PdfFormField, values: readonly string[]): void {
	const allowed = new Set(field.options.map(option => option.value))
	const wanted = field.multiSelect ? [...new Set(values)] : values.slice(0, 1)

	if (!field.editable && wanted.some(value => !allowed.has(value))) throw new PdfFieldError("notAnOption")

	if (!field.multiSelect) {
		widget.setChoiceValue(wanted[0] ?? "")

		return
	}

	// MuPDF sets one value only: a multiple selection is written as the /V array, with /I listing the chosen option
	// indices in ascending order (PDF 32000-1 §12.7.4.4) so other viewers highlight the same options.
	const target = deref(fieldOf(widget.getObject()))
	const ordered = field.options.map((option, index) => ({ option, index })).filter(entry => wanted.includes(entry.option.value))

	if (ordered.length === 0) {
		target.delete("V")
		target.delete("I")

		return
	}

	const valueArray = document.newArray()
	const indexArray = document.newArray()

	for (const entry of ordered) {
		valueArray.push(document.newString(entry.option.value))
		indexArray.push(entry.index)
	}

	target.put("V", ordered.length === 1 ? document.newString(ordered[0]?.option.value ?? "") : valueArray)
	target.put("I", indexArray)
}

// Sets one field from one of its widgets. Refuses (PdfFieldError, nothing changed) a read-only field, a password
// field, a value of the wrong kind and, for a combo that is not editable or a list, a value that is not an option. Text is clipped
// to the field's maximum length. Returns the pages whose appearance changed.
export function setFieldValue(
	document: PDFDocument,
	page: PDFPage,
	pageIndex0: number,
	widgetObject: number,
	value: PdfFieldValue
): number[] {
	const widget = findWidget(page, widgetObject)

	if (widget === null) throw new PdfFieldError("notFound")

	const field = describeWidget(widget, pageIndex0)

	if (field.readOnly) throw new PdfFieldError("readOnly")
	if (field.password) throw new PdfFieldError("password")

	switch (value.kind) {
		case "text": {
			if (field.kind === "text") widget.setTextValue(clipFieldText(field, value.text))
			else if (field.kind === "combo" && field.editable) widget.setChoiceValue(value.text)
			else throw new PdfFieldError("wrongKind")

			break
		}
		case "checkbox": {
			if (field.kind !== "checkbox") throw new PdfFieldError("wrongKind")

			// Check boxes sharing one name act as a group: this widget is checked when the field holds its on state.
			if ((field.value === field.onState) !== value.checked) widget.toggle()

			break
		}
		case "radio": {
			if (field.kind !== "radio") throw new PdfFieldError("wrongKind")
			if (field.value !== field.onState) widget.toggle()

			break
		}
		case "choice": {
			if (field.kind !== "combo" && field.kind !== "list") throw new PdfFieldError("wrongKind")

			setChoice(document, widget, field, value.values)

			break
		}
	}

	return refreshField(document, page, pageIndex0, widget)
}

// Every widget of the document's fields by page (from the AcroForm field tree; pages without fields are never
// loaded).
function widgetPages(document: PDFDocument): Map<number, Set<number>> {
	const fields = deref(document.getTrailer().get("Root", "AcroForm", "Fields"))
	const byPage = new Map<number, Set<number>>()
	const pageNumbers = new Map<number, number>()
	const count = document.countPages()

	for (let index = 0; index < count; index++) {
		const page = document.findPage(index)

		if (page.isIndirect()) pageNumbers.set(page.asIndirect(), index)
	}

	const seen = new Set<number>()
	const visit = (node: PDFObject, depth: number): void => {
		if (depth > MAX_PARENT_DEPTH || seen.size > MAX_KIDS) return
		if (node.isIndirect()) {
			if (seen.has(node.asIndirect())) return

			seen.add(node.asIndirect())
		}

		const dict = deref(node)
		const kids = deref(dict.get("Kids"))

		if (kids.isArray()) {
			for (let index = 0; index < kids.length; index++) visit(kids.get(index), depth + 1)

			return
		}

		const pageObject = dict.get("P")
		const page = pageObject.isIndirect() ? pageNumbers.get(pageObject.asIndirect()) : undefined

		if (page !== undefined && node.isIndirect()) {
			const set = byPage.get(page) ?? new Set<number>()

			set.add(node.asIndirect())
			byPage.set(page, set)
		}
	}

	if (fields.isArray()) for (let index = 0; index < fields.length; index++) visit(fields.get(index), 0)

	return byPage
}

// Clear form: every field back to its default value (/DV, else empty), appearances regenerated. Returns the pages
// touched.
export function resetForm(document: PDFDocument): number[] {
	// No field list: every field (an empty list resets nothing).
	document.resetForm(document.newNull(), true)

	const byPage = widgetPages(document)

	for (const [index, widgets] of byPage) {
		for (const widget of document.loadPage(index).getWidgets()) {
			if (widgets.has(widget.getObject().asIndirect())) widget.update()
		}
	}

	return [...byPage.keys()].sort((a, b) => a - b)
}

// Required fields without a value, for the warning on save (never a refusal). Fields that cannot be filled here
// (read-only, password) are left out.
export function missingRequiredFields(document: PDFDocument): PdfFormField[] {
	const missing: PdfFormField[] = []

	for (const [index] of [...widgetPages(document)].sort((a, b) => a[0] - b[0])) {
		for (const field of readPageFields(document.loadPage(index), index)) {
			const empty = field.kind === "checkbox" || field.kind === "radio" ? field.value === "Off" : field.value === ""

			if (field.required && empty && !field.readOnly && !field.password && missing.every(other => other.name !== field.name))
				missing.push(field)
		}
	}

	return missing
}
