import { fieldLocked, type PdfCertificationLevel, type PdfFieldLock } from "../pdfsign/policy"

// Which kinds of change the editor offers on a document, from its signatures and its author's restrictions. A signed
// document keeps its signatures valid only through changes their signers allowed, saved incrementally: approval
// signatures allow form filling, annotations and further signatures; a certification allows nothing (level 1), form
// filling and signing (2), or also annotations (3); field locks forbid changing the fields they name. Everything else
// (pages, content, redaction) is not offered on a signed document. Restrictions an author set with an owner password
// (permissions) are honoured unless the owner password unlocked the document.

// The kinds of change, by what a signature's permissions and a document's restrictions speak of.
export type PdfToolClass =
	// Filling in form fields, resetting the form.
	| "formFill"
	// Annotations and comments.
	| "annotate"
	// Visual and certificate signatures.
	| "sign"
	// Page organisation (reorder, rotate, delete, insert, crop).
	| "pages"
	// The page content itself: text editing, redaction, OCR.
	| "content"
	// Passwords and restrictions.
	| "security"

export const PDF_TOOL_CLASSES: readonly PdfToolClass[] = ["formFill", "annotate", "sign", "pages", "content", "security"]

// What a document's signatures declare.
export interface PdfSignatureState {
	// Fully qualified names of the signed signature fields.
	readonly fields: readonly string[]
	// The certifying signature's level, or null when no signature certifies.
	readonly certification: PdfCertificationLevel | null
	// Every lock the signatures declare.
	readonly locks: readonly PdfFieldLock[]
}

export const PDF_UNSIGNED: PdfSignatureState = { fields: [], certification: null, locks: [] }

// The author's restrictions (an owner password's permissions); `owner`: the owner password unlocked them.
export interface PdfRestrictions {
	readonly owner: boolean
	readonly print: boolean
	readonly edit: boolean
	readonly annotate: boolean
	readonly form: boolean
	readonly assemble: boolean
}

export const PDF_UNRESTRICTED: PdfRestrictions = { owner: true, print: true, edit: true, annotate: true, form: true, assemble: true }

// Why a kind of change is not offered: the signatures forbid it, or the author restricted it.
export type PdfToolBlock = "signed" | "restricted"

export type PdfToolAvailability = Readonly<Record<PdfToolClass, PdfToolBlock | null>>

// The kinds of change the signatures allow (kept valid by an incremental save).
export function signatureAllows(signatures: PdfSignatureState, tool: PdfToolClass): boolean {
	if (signatures.fields.length === 0) return true

	switch (tool) {
		case "formFill":
		case "sign":
			return signatures.certification !== 1
		case "annotate":
			return signatures.certification === null || signatures.certification === 3
		case "pages":
		case "content":
		case "security":
			return false
	}
}

function restrictionAllows(restrictions: PdfRestrictions, tool: PdfToolClass): boolean {
	if (restrictions.owner) return true

	switch (tool) {
		case "formFill":
		case "sign":
			return restrictions.form || restrictions.annotate
		case "annotate":
			return restrictions.annotate
		case "pages":
			return restrictions.assemble || restrictions.edit
		case "content":
			return restrictions.edit
		case "security":
			return false
	}
}

export function toolAvailability(signatures: PdfSignatureState, restrictions: PdfRestrictions): PdfToolAvailability {
	const verdict = (tool: PdfToolClass): PdfToolBlock | null =>
		!restrictionAllows(restrictions, tool) ? "restricted" : !signatureAllows(signatures, tool) ? "signed" : null

	return {
		formFill: verdict("formFill"),
		annotate: verdict("annotate"),
		sign: verdict("sign"),
		pages: verdict("pages"),
		content: verdict("content"),
		security: verdict("security")
	}
}

// Whether a field may be filled in: never one a signature locks.
export function fieldEditable(signatures: PdfSignatureState, field: string): boolean {
	return signatures.fields.length === 0 || (signatures.certification !== 1 && !fieldLocked(signatures.locks, field))
}
