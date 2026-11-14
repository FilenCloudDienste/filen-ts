import {
	createFormWidgetScope,
	HARDENED_ATTRIBUTE,
	opaqueFieldId,
	opaqueFieldName,
	PASSWORD_MANAGER_OPT_OUTS,
	type FormWidgetScope
} from "@filen/shared/dom/formFieldNames"

// The attributes of an HTML control the PDF editor overlays on a form field: the same hardening contract as the
// mobile app's sweep over pdf.js widgets (@filen/shared/dom/formHardening), applied when the control is built.
//
// - never type=password: a document can set the password flag on a field it labels "Filen password", and the
//   browser's or an extension's password manager would offer the user's real credential to it. A password field is
//   a text input masked by CSS (`masked`, as the web's SecretInput), which no password manager treats as a
//   credential;
// - autocomplete=off and every password-manager opt-out;
// - never the document's field name or id: an opaque name per document field (radio groups stay grouped, across
//   pages too) and a fresh id;
// - never wrapped in a <form>;
// - the accessible name from the field's /TU, else the caller's generic label (never the field's name).
//
// Plain data, no DOM: a React overlay spreads it onto the element (`masked` → PDF_MASKED_CLASS or the
// -webkit-text-security style).

export { createFormWidgetScope, type FormWidgetScope }

// The class masking a password field's text (css/pdf.css).
export const PDF_MASKED_CLASS = "fo-pdf-masked"

export type PdfFormControlKind = "text" | "checkbox" | "radio" | "combo" | "list"

export interface PdfFormControlField {
	// The document's fully qualified field name: only a key into the scope, never output.
	readonly name: string
	readonly kind: PdfFormControlKind
	// /TU; empty when the document gives none.
	readonly label: string
	readonly password: boolean
	readonly multiline: boolean
	readonly readOnly: boolean
	readonly required: boolean
	// 0: no limit.
	readonly maxLength: number
	readonly multiSelect: boolean
}

// React-ready props (camelCase), every value a string or boolean.
export interface PdfFormControlProps {
	readonly element: "input" | "textarea" | "select"
	// input only.
	readonly type?: "text" | "checkbox" | "radio"
	readonly name: string
	readonly id: string
	readonly masked: boolean
	readonly autoComplete: "off"
	readonly autoCapitalize: "off"
	readonly autoCorrect: "off"
	readonly spellCheck: false
	readonly readOnly: boolean
	readonly disabled: boolean
	readonly required: boolean
	readonly multiple?: boolean
	readonly maxLength?: number
	readonly "aria-label": string
	readonly "data-1p-ignore": "true"
	readonly "data-lpignore": "true"
	readonly "data-bwignore": "true"
	readonly "data-form-type": "other"
	readonly "data-protonpass-ignore": "true"
	readonly "data-filen-hardened": ""
}

function elementOf(field: PdfFormControlField): PdfFormControlProps["element"] {
	if (field.kind === "list" || field.kind === "combo") return "select"

	return field.kind === "text" && field.multiline && !field.password ? "textarea" : "input"
}

// The control for `field`, named within `scope` (one scope per open document, kept for its life). A combo is a
// select here; an editable combo's overlay is a text input with the field's options offered alongside (the caller's
// choice), so it is described as kind "text".
export function pdfFormControlProps(field: PdfFormControlField, scope: FormWidgetScope, fallbackLabel: string): PdfFormControlProps {
	const element = elementOf(field)
	const label = field.label.trim()
	const choice = field.kind === "list" || field.kind === "combo"
	const toggle = field.kind === "checkbox" || field.kind === "radio"

	return {
		element,
		...(element === "input" ? { type: toggle ? field.kind : "text" } : {}),
		name: opaqueFieldName(scope, field.name),
		id: opaqueFieldId(scope),
		masked: field.kind === "text" && field.password,
		autoComplete: "off",
		autoCapitalize: "off",
		autoCorrect: "off",
		spellCheck: false,
		// A checkbox, radio or select cannot be read-only in HTML: it is disabled instead.
		readOnly: field.readOnly && !choice && !toggle,
		disabled: field.readOnly && (choice || toggle),
		required: field.required,
		...(choice ? { multiple: field.kind === "list" && field.multiSelect } : {}),
		...(field.kind === "text" && field.maxLength > 0 ? { maxLength: field.maxLength } : {}),
		"aria-label": label === "" ? fallbackLabel : label,
		...PASSWORD_MANAGER_OPT_OUTS,
		[HARDENED_ATTRIBUTE]: ""
	}
}
