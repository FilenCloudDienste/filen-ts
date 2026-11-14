import { preparedPassword, type PdfAllowed, type PdfSecurityChoice } from "@filen/office/core/pdfedit/security"
import type { PdfSecurityDescription } from "@filen/office/dom/pdfedit/security"
import { pdfPasswordAllowed } from "@/features/office/lib/pdfPassword"

// The Protect document dialog's rules: the form a document starts with, and the choice (or the field errors) a form
// makes. The engine plans the write options from the choice and refuses again what these rules let through.

export type ProtectMode = "none" | "open" | "restrict"

export interface ProtectForm {
	readonly mode: ProtectMode
	// Password to open (mode "open").
	readonly password: string
	readonly confirm: string
	// Mode "restrict": the owner password, and the optional password to open.
	readonly ownerPassword: string
	readonly ownerConfirm: string
	readonly openPassword: string
	readonly openConfirm: string
	readonly allowed: PdfAllowed
	// Re-encrypt an RC4 file with AES-256 when nothing else changes.
	readonly upgrade: boolean
}

export type PasswordIssue = "mismatch" | "refused"

export interface ProtectErrors {
	readonly password: PasswordIssue | null
	readonly owner: PasswordIssue | null
	readonly open: PasswordIssue | null
	readonly same: boolean
}

export interface ProtectResult {
	// What applying does; null while the form is incomplete or has errors. "keep" means nothing to apply.
	readonly choice: PdfSecurityChoice | null
	readonly errors: ProtectErrors
}

const NO_ERRORS: ProtectErrors = { password: null, owner: null, open: null, same: false }

// The protection the document has now, as the dialog's choices.
export function currentMode(current: PdfSecurityDescription): ProtectMode {
	if (current.method === "none") return "none"

	return current.restricted ? "restrict" : "open"
}

// Changes need owner access on an encrypted document; without it only keeping (or upgrading) is possible.
export function isLocked(current: PdfSecurityDescription): boolean {
	return current.method !== "none" && !current.ownerAccess
}

export function initialForm(current: PdfSecurityDescription): ProtectForm {
	return {
		mode: currentMode(current),
		password: "",
		confirm: "",
		ownerPassword: "",
		ownerConfirm: "",
		openPassword: "",
		openConfirm: "",
		allowed: current.allowed,
		upgrade: current.rc4 && current.upgrade === null
	}
}

function issue(password: string, confirm: string): PasswordIssue | null {
	if (password === "") return null
	if (!pdfPasswordAllowed(password)) return "refused"

	return confirm === password ? null : "mismatch"
}

function sameAllowed(a: PdfAllowed, b: PdfAllowed): boolean {
	return a.print === b.print && a.copy === b.copy && a.change === b.change
}

// Equal as the handler stores them (SASLprep'd).
function samePassword(a: string, b: string): boolean {
	const left = preparedPassword(a)
	const right = preparedPassword(b)

	return left.ok && right.ok ? left.value === right.value : a === b
}

function unchanged(current: PdfSecurityDescription, form: ProtectForm): PdfSecurityChoice {
	return form.upgrade && current.rc4 && current.upgrade === null ? { kind: "upgrade" } : { kind: "keep" }
}

export function protectChoice(current: PdfSecurityDescription, form: ProtectForm): ProtectResult {
	const mode = currentMode(current)

	if (isLocked(current)) return { choice: unchanged(current, form), errors: NO_ERRORS }

	if (form.mode === "none") return { choice: mode === "none" ? { kind: "keep" } : { kind: "remove" }, errors: NO_ERRORS }

	if (form.mode === "open") {
		const password = issue(form.password, form.confirm)
		const errors = { ...NO_ERRORS, password }

		if (form.password === "" && form.confirm === "") return { choice: mode === "open" ? unchanged(current, form) : null, errors }

		return { choice: password === null && form.password !== "" ? { kind: "open", password: form.password } : null, errors }
	}

	const owner = issue(form.ownerPassword, form.ownerConfirm)
	const open = issue(form.openPassword, form.openConfirm)
	const same = form.ownerPassword !== "" && form.openPassword !== "" && samePassword(form.ownerPassword, form.openPassword)
	const errors = { password: null, owner, open, same }
	const blank = form.ownerPassword === "" && form.ownerConfirm === "" && form.openPassword === "" && form.openConfirm === ""

	if (blank && mode === "restrict" && sameAllowed(form.allowed, current.allowed)) return { choice: unchanged(current, form), errors }
	if (form.ownerPassword === "" || owner !== null || open !== null || same) return { choice: null, errors }
	// A typed confirmation without the password itself is incomplete.
	if (form.openPassword === "" && form.openConfirm !== "") return { choice: null, errors: { ...errors, open: "mismatch" } }

	return {
		choice: {
			kind: "restrict",
			ownerPassword: form.ownerPassword,
			openPassword: form.openPassword === "" ? null : form.openPassword,
			allowed: form.allowed
		},
		errors
	}
}

// Whether applying `choice` changes anything.
export function changesSomething(choice: PdfSecurityChoice | null): choice is PdfSecurityChoice {
	return choice !== null && choice.kind !== "keep"
}
