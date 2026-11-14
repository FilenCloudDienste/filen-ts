import type { PdfSecurityChoice, PdfSecuritySummary } from "./security"
import type { PdfRestrictions, PdfSignatureState, PdfToolAvailability, PdfToolClass } from "./signaturePolicy"

// What the editor knows of its document, as plain data the page holds: the snapshot every change answers with, and the
// form's widgets per page. Coordinates are the page's user space with the origin at its bottom left (y up), as a pdf.js
// annotation's rectangle is given, after the page's own rotation and crop: a viewport over [0, 0, width, height] maps
// them to the screen.

export type PdfRect = readonly [number, number, number, number]

export type PdfWidgetType = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "button" | "signature"

export interface PdfWidgetOption {
	readonly value: string
	readonly label: string
}

export interface PdfWidgetSummary {
	// The widget annotation's object number: stable while the document is open, and the id pdf.js gives the same
	// widget ("<number>R"), so an input made before the editor opened finds its widget.
	readonly id: number
	// 0-based page.
	readonly page: number
	readonly rect: PdfRect
	readonly type: PdfWidgetType
	// The field's fully qualified name (never shown to the user, never used as a DOM name).
	readonly field: string
	// The field's tooltip (/TU), its accessible name; "" without one.
	readonly label: string
	// Text, the first chosen option's export value, a checkbox's or radio button's state ("Off" when off).
	readonly value: string
	// A choice field's chosen export values (several in a multiple-selection list).
	readonly selected: readonly string[]
	// A checkbox's or radio button's "on" state; null for other types.
	readonly onState: string | null
	// A choice field's options: the export value stored, the text shown.
	readonly options: readonly PdfWidgetOption[]
	// 0: no limit.
	readonly maxLength: number
	readonly readOnly: boolean
	readonly required: boolean
	readonly multiline: boolean
	// The document's password flag: shown masked, never filled (its value would be stored in the file).
	readonly password: boolean
	readonly comb: boolean
	readonly multiSelect: boolean
	// A combo box that takes text of its own.
	readonly editable: boolean
	// A signature locks the field.
	readonly locked: boolean
}

export interface PdfPageWidgets {
	readonly page: number
	readonly widgets: readonly PdfWidgetSummary[]
}

export interface PdfEncryptionState {
	// "None", or the method ("Standard V5 R6 256-bit AES" and the like).
	readonly method: string
	readonly access: "none" | "user" | "owner"
}

// The document's protection, and the protection the next save writes when the user chose one in the Protect dialog
// (its kind; null: the file keeps what it has).
export interface PdfEditSecurity extends PdfSecuritySummary {
	readonly pending: PdfSecurityChoice["kind"] | null
}

export interface PdfFormState {
	// Fields in the AcroForm.
	readonly fields: number
	// Some field has calculate, format, validate or keystroke actions (they never run here).
	readonly scripts: boolean
	// XFA data: none, alongside an AcroForm (filled through it), or the whole form.
	readonly xfa: "none" | "hybrid" | "only"
}

export interface PdfEditState {
	// Bumped by every change, undo, redo and save: a snapshot with a higher revision replaces one with a lower.
	readonly revision: number
	readonly pageCount: number
	// Changes since the last save (or since opening).
	readonly dirty: boolean
	readonly canUndo: boolean
	readonly canRedo: boolean
	// The command a step undoes or redoes (a command's label), null when there is none.
	readonly undoLabel: string | null
	readonly redoLabel: string | null
	// Kinds of change made since opening (the save planner's input).
	readonly changes: readonly PdfToolClass[]
	readonly versions: number
	readonly signatures: PdfSignatureState
	readonly restrictions: PdfRestrictions
	readonly tools: PdfToolAvailability
	readonly encryption: PdfEncryptionState
	readonly security: PdfEditSecurity
	// The document carries accessibility tags (/MarkInfo /Marked and a structure tree).
	readonly tagged: boolean
	readonly form: PdfFormState
}

// A command's outcome: the pages whose rendering changed, and the snapshot after it.
export interface PdfCommandResult {
	readonly pages: readonly number[]
	readonly state: PdfEditState
	// The widgets of the pages that changed.
	readonly widgets: readonly PdfPageWidgets[]
	// What the command made, for the page to select (an annotation: its page and object number).
	readonly created?: { readonly page: number; readonly id: number }
}
