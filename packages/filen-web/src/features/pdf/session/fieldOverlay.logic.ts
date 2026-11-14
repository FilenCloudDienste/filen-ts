import type { PdfWidgetSummary } from "@filen/office/core/pdfedit"

// The form fields drawn over a page as controls, from either engine: pdf.js's widget annotations before the swap,
// the editor's widget summaries after it. A field is addressed by its widget's object number, the same in both (pdf.js
// gives "<number>R"), so an input made before the editor opened lands on the same widget.

export type OverlayFieldType = "text" | "checkbox" | "radio" | "choice"

export interface OverlayField {
	readonly id: number
	readonly type: OverlayFieldType
	// Bottom-left user space, as the page's viewport maps it.
	readonly rect: readonly [number, number, number, number]
	readonly value: string
	// A checkbox's or radio button's on state ("Off" is off).
	readonly onState: string | null
	readonly options: readonly string[]
	readonly label: string
	readonly readOnly: boolean
	readonly multiline: boolean
	readonly maxLength: number
}

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

// pdf.js widget annotations (getAnnotations), the fields a control is drawn for: text, checkboxes, radio buttons and
// choices; push buttons and signatures are not. Hidden widgets are left out.
export function pdfjsFields(annotations: readonly unknown[]): OverlayField[] {
	const fields: OverlayField[] = []

	for (const annotation of annotations) {
		if (!isRecord(annotation) || annotation["subtype"] !== "Widget" || annotation["hidden"] === true) continue

		const id = objectNumber(annotation["id"])
		const rect = rectOf(annotation["rect"])
		const fieldType = annotation["fieldType"]

		if (id === null || rect === null) continue

		const type: OverlayFieldType | null =
			fieldType === "Tx"
				? "text"
				: fieldType === "Ch"
					? "choice"
					: fieldType === "Btn" && annotation["checkBox"] === true
						? "checkbox"
						: fieldType === "Btn" && annotation["radioButton"] === true
							? "radio"
							: null

		if (type === null) continue

		const value = annotation["fieldValue"]
		const options = Array.isArray(annotation["options"])
			? (annotation["options"] as unknown[]).map(option => (isRecord(option) ? text(option["displayValue"]) : ""))
			: []
		const onState = type === "checkbox" || type === "radio" ? text(annotation["exportValue"] ?? annotation["buttonValue"]) : ""

		fields.push({
			id,
			type,
			rect,
			value: Array.isArray(value) ? text(value[0]) : text(value),
			onState: onState.length > 0 ? onState : null,
			options,
			label: text(annotation["alternativeText"]),
			readOnly: annotation["readOnly"] === true,
			multiline: annotation["multiLine"] === true,
			maxLength: typeof annotation["maxLen"] === "number" ? annotation["maxLen"] : 0
		})
	}

	return fields
}

export function engineFields(widgets: readonly PdfWidgetSummary[]): OverlayField[] {
	return widgets.flatMap(widget => {
		const type: OverlayFieldType | null =
			widget.type === "text"
				? "text"
				: widget.type === "checkbox" || widget.type === "radio"
					? widget.type
					: widget.type === "combobox" || widget.type === "listbox"
						? "choice"
						: null

		return type === null
			? []
			: [
					{
						id: widget.id,
						type,
						rect: widget.rect,
						value: widget.value,
						onState: widget.onState,
						options: widget.options,
						label: widget.label,
						readOnly: widget.readOnly || widget.locked,
						multiline: widget.multiline,
						maxLength: widget.maxLength
					}
				]
	})
}

// Whether a checkbox or radio button is on.
export function fieldChecked(field: OverlayField): boolean {
	return field.value !== "" && field.value !== "Off" && (field.onState === null || field.value === field.onState)
}
