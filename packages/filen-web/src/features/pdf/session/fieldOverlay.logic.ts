import type { PdfWidgetOption, PdfWidgetSummary } from "@filen/office/core/pdfedit"
import type { PdfFormControlField, PdfFormControlKind } from "@filen/office/dom/pdf"
import { createFormWidgetScope, type FormWidgetScope } from "@filen/office/dom/pdf"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"

// The form fields drawn over a page as controls, from either engine: pdf.js's widget annotations before the swap,
// the editor's widget summaries after it (in the page's tab order). A field is addressed by its widget's object
// number, the same in both (pdf.js gives "<number>R"), so an input made before the editor opened lands on the same
// widget. The document's field name only keys the per-document naming scope (dom/pdf/formWidgets.ts); it never
// reaches the DOM.

export interface OverlayField {
	readonly id: number
	readonly kind: PdfFormControlKind
	// The fully qualified field name (a key into the naming scope only).
	readonly name: string
	// Bottom-left user space, as the page's viewport maps it.
	readonly rect: readonly [number, number, number, number]
	// Text; a checkbox's or radio button's state ("Off" is off); a choice's first selected export value.
	readonly value: string
	// A choice's selected export values.
	readonly selected: readonly string[]
	// A checkbox's or radio button's on state.
	readonly onState: string | null
	readonly options: readonly PdfWidgetOption[]
	// /TU.
	readonly label: string
	readonly readOnly: boolean
	readonly required: boolean
	// The document's password flag: masked, never filled.
	readonly password: boolean
	readonly multiline: boolean
	readonly comb: boolean
	// 0: no limit.
	readonly maxLength: number
	readonly multiSelect: boolean
	// A combo box taking text of its own.
	readonly editable: boolean
}

// Field flags (PDF 32000-1 Table 230).
const FF_EDIT = 1 << 18

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null
}

function rectOf(value: unknown): readonly [number, number, number, number] | null {
	if (!Array.isArray(value) || value.length !== 4) return null

	const [a, b, c, d] = value as unknown[]

	return typeof a === "number" && typeof b === "number" && typeof c === "number" && typeof d === "number" ? [a, b, c, d] : null
}

function objectNumber(id: unknown): number | null {
	const match = typeof id === "string" ? /^(\d+)R$/.exec(id) : null

	return match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
}

function text(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function kindOf(annotation: Readonly<Record<string, unknown>>): PdfFormControlKind | null {
	switch (annotation["fieldType"]) {
		case "Tx":
			return "text"
		case "Ch":
			return annotation["combo"] === true ? "combo" : "list"
		case "Btn":
			return annotation["checkBox"] === true ? "checkbox" : annotation["radioButton"] === true ? "radio" : null
		default:
			return null
	}
}

// pdf.js widget annotations (getAnnotations), in the page's annotation order: text, checkboxes, radio buttons and
// choices; push buttons and signatures are not. Hidden widgets are left out.
export function pdfjsFields(annotations: readonly unknown[]): OverlayField[] {
	const fields: OverlayField[] = []

	for (const annotation of annotations) {
		if (!isRecord(annotation) || annotation["subtype"] !== "Widget" || annotation["hidden"] === true) continue

		const id = objectNumber(annotation["id"])
		const rect = rectOf(annotation["rect"])
		const kind = kindOf(annotation)

		if (id === null || rect === null || kind === null) continue

		const raw = annotation["fieldValue"]
		const values = Array.isArray(raw) ? (raw as unknown[]).map(text) : text(raw) === "" ? [] : [text(raw)]
		const choice = kind === "combo" || kind === "list"
		const options = Array.isArray(annotation["options"])
			? (annotation["options"] as unknown[]).map(option =>
					isRecord(option)
						? { value: text(option["exportValue"]), label: text(option["displayValue"] ?? option["exportValue"]) }
						: { value: "", label: "" }
				)
			: []
		const onState = kind === "checkbox" || kind === "radio" ? text(annotation["exportValue"] ?? annotation["buttonValue"]) : ""
		const flags = typeof annotation["fieldFlags"] === "number" ? annotation["fieldFlags"] : 0

		fields.push({
			id,
			kind,
			name: text(annotation["fieldName"]),
			rect,
			value: values[0] ?? "",
			selected: choice ? values : [],
			onState: onState.length > 0 ? onState : null,
			options,
			label: text(annotation["alternativeText"]),
			readOnly: annotation["readOnly"] === true,
			required: annotation["required"] === true,
			password: kind === "text" && annotation["password"] === true,
			multiline: kind === "text" && annotation["multiLine"] === true,
			comb: kind === "text" && annotation["comb"] === true,
			maxLength: kind === "text" && typeof annotation["maxLen"] === "number" ? annotation["maxLen"] : 0,
			multiSelect: kind === "list" && annotation["multiSelect"] === true,
			editable: kind === "combo" && (flags & FF_EDIT) !== 0
		})
	}

	return fields
}

const ENGINE_KINDS: Readonly<Partial<Record<PdfWidgetSummary["type"], PdfFormControlKind>>> = {
	text: "text",
	checkbox: "checkbox",
	radio: "radio",
	combobox: "combo",
	listbox: "list"
}

// The editor's widgets in tab order; a field a signature locks is read-only.
export function engineFields(widgets: readonly PdfWidgetSummary[]): OverlayField[] {
	return widgets.flatMap(widget => {
		const kind = ENGINE_KINDS[widget.type]

		return kind === undefined
			? []
			: [
					{
						id: widget.id,
						kind,
						name: widget.field,
						rect: widget.rect,
						value: widget.value,
						selected: widget.selected,
						onState: widget.onState,
						options: widget.options,
						label: widget.label,
						readOnly: widget.readOnly || widget.locked,
						required: widget.required,
						password: widget.password,
						multiline: widget.multiline,
						comb: widget.comb,
						maxLength: widget.maxLength,
						multiSelect: widget.multiSelect,
						editable: widget.editable
					}
				]
	})
}

// Whether a checkbox or radio button is on.
export function fieldChecked(field: OverlayField): boolean {
	return field.value !== "" && field.value !== "Off" && (field.onState === null || field.value === field.onState)
}

// The hardened control's description: an editable combo box is a text input with its options offered beside it.
export function controlField(field: OverlayField): PdfFormControlField {
	return {
		name: field.name,
		kind: field.kind === "combo" && field.editable ? "text" : field.kind,
		label: field.label,
		password: field.password,
		multiline: field.multiline,
		readOnly: field.readOnly || field.password,
		required: field.required,
		maxLength: field.maxLength,
		multiSelect: field.multiSelect
	}
}

// A required field without a value (the save's warning marks it).
export function fieldEmpty(field: OverlayField): boolean {
	if (field.kind === "checkbox" || field.kind === "radio") return !fieldChecked(field)
	if (field.kind === "combo" || field.kind === "list") return field.selected.length === 0 && field.value === ""

	return field.value === ""
}

// The CSS a comb field's characters are spread with: one per cell of its box (monospace, about 0.6 em wide).
export function combSpacing(
	boxWidth: number,
	maxLength: number,
	fontSize: number
): { readonly letterSpacing: number; readonly paddingLeft: number } {
	const cell = maxLength > 0 ? boxWidth / maxLength : boxWidth
	const gap = Math.max(0, cell - fontSize * 0.6)

	return { letterSpacing: gap, paddingLeft: gap / 2 }
}

// The form state the overlay keeps per open document (it outlives the page overlays, which remount whenever the page
// is drawn anew): the naming scope (one per document, so radio groups stay grouped across pages), text typed and not
// yet committed, by widget (a change not saved yet: a save commits it first), the control that had the focus when its
// page's overlay was taken down (given back when it mounts again), and whether a save warned about empty required
// fields (they are marked from then on).
export interface FieldFocus {
	readonly widget: number
	readonly start: number | null
	readonly end: number | null
}

export interface FieldDraft {
	// 0-based.
	readonly page: number
	readonly text: string
}

// Runs a change on the editor (PdfEditSwap.edit): `dropped` when it never will.
export type FormDraftEdit = (change: (session: PdfEditSessionModel) => Promise<unknown>, dropped: () => void) => void

export class FormOverlaySession {
	readonly scope: FormWidgetScope = createFormWidgetScope()
	private readonly drafts = new Map<number, FieldDraft>()
	private refocus: FieldFocus | null = null
	private warned = false
	private readonly listeners = new Set<() => void>()

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	requiredWarned = (): boolean => this.warned

	// Text typed into a field and not committed: unsaved like any change.
	drafted = (): boolean => this.drafts.size > 0

	private changed(): void {
		for (const listener of this.listeners) listener()
	}

	draft(widget: number): FieldDraft | undefined {
		return this.drafts.get(widget)
	}

	// The draft of `widget` (null: none, the field shows its value).
	setDraft(widget: number, draft: FieldDraft | null): void {
		const had = this.drafts.has(widget)

		if (draft === null) this.drafts.delete(widget)
		else this.drafts.set(widget, draft)

		if (had !== (draft !== null)) this.changed()
	}

	// Every draft committed as the field's value (one step each, in order), once each: resolves when the editor ran
	// them. One that does not run is a draft again.
	commitDrafts(edit: FormDraftEdit): Promise<void> {
		const pending = [...this.drafts].map(
			([widget, draft]) =>
				new Promise<void>(resolve => {
					const keep = (): void => {
						if (!this.drafts.has(widget)) this.setDraft(widget, draft)

						resolve()
					}

					this.setDraft(widget, null)
					edit(
						session =>
							session
								.dispatch("forms.setField", { page: draft.page, widget, value: { kind: "text", text: draft.text } })
								.then(
									() => {
										resolve()
									},
									(error: unknown) => {
										keep()

										throw error
									}
								),
						keep
					)
				})
		)

		return Promise.all(pending).then(() => undefined)
	}

	// The control of `widget` went with the focus on it (and this selection).
	noteFocus(focus: FieldFocus): void {
		this.refocus = focus
	}

	// Whether `widget`'s control is to take the focus back (once), and its selection.
	takeFocus(widget: number): FieldFocus | null {
		const focus = this.refocus

		if (focus?.widget !== widget) return null

		this.refocus = null

		return focus
	}

	warnRequired(): void {
		if (this.warned) return

		this.warned = true
		this.changed()
	}
}

const sessions = new WeakMap<object, FormOverlaySession>()

// The overlay session of the document `owner` stands for (the viewer's swap: the same before and after the editor
// takes the document).
export function formOverlaySession(owner: object): FormOverlaySession {
	let session = sessions.get(owner)

	if (session === undefined) {
		session = new FormOverlaySession()
		sessions.set(owner, session)
	}

	return session
}
