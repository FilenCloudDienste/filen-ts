import type * as Mupdf from "mupdf"
import {
	allowedFromPermissions,
	encryptionMethod,
	hasOwnerAccess,
	isRc4,
	isRestricted,
	passwordCandidates,
	PDF_AUTH_OWNER,
	PDF_PERMISSIONS_ALL,
	planSecurity,
	upgradeRefusal,
	type PdfEncryptFields,
	type PdfHeldAccess,
	type PdfSecurityChoice,
	type PdfSecurityPlan,
	type PdfSecurityState,
	type PdfSecuritySummary
} from "../../../core/pdfedit/security"
import type { PdfPermission } from "../protocol"

// The security block of the engine: reads a document's encryption, tracks what the session is authenticated with,
// unlocks owner rights and plans the write options of a save. None of it touches pages or the undo journal; the
// write options take effect in the save (`saveToBuffer`), which also gives the session's document the new encryption.

// What the Protect dialog and the tools read. Carries no password.
export interface PdfSecurityDescription extends PdfSecuritySummary {
	// What the session may do now (MuPDF's hasPermission: everything with owner rights). Tools honour these.
	readonly granted: Readonly<Record<PdfPermission, boolean>>
}

const PERMISSIONS: readonly (readonly [PdfPermission, Mupdf.DocumentPermission])[] = [
	["print", "print"],
	["printHq", "print-hq"],
	["copy", "copy"],
	["edit", "edit"],
	["annotate", "annotate"],
	["form", "form"],
	["assemble", "assemble"],
	["accessibility", "accessibility"]
]

function name(object: Mupdf.PDFObject): string | null {
	return object.isName() ? object.asName() : null
}

function number(object: Mupdf.PDFObject): number | null {
	return object.isNumber() ? object.asNumber() : null
}

function encryptDictionary(document: Mupdf.PDFDocument): Mupdf.PDFObject | null {
	const dictionary = document.getTrailer().get("Encrypt")

	return dictionary.isDictionary() ? dictionary : null
}

// The /Encrypt entries that tell the method, or null when the document is not encrypted.
export function readEncryptFields(document: Mupdf.PDFDocument): PdfEncryptFields | null {
	const dictionary = encryptDictionary(document)

	if (dictionary === null) return null

	const streamFilter = name(dictionary.get("StmF"))

	return {
		filter: name(dictionary.get("Filter")),
		v: number(dictionary.get("V")),
		r: number(dictionary.get("R")),
		length: number(dictionary.get("Length")),
		cfm: streamFilter === null ? null : streamFilter === "Identity" ? "None" : name(dictionary.get("CF", streamFilter, "CFM"))
	}
}

// The document's security for the rules (core/pdfedit/security). `held`: what the session is authenticated with.
export function securityState(document: Mupdf.PDFDocument, held: PdfHeldAccess): PdfSecurityState {
	const dictionary = encryptDictionary(document)
	const permissions = dictionary === null ? null : number(dictionary.get("P"))

	return {
		method: encryptionMethod(readEncryptFields(document)),
		permissions: permissions === null ? PDF_PERMISSIONS_ALL : permissions | 0,
		held
	}
}

// What the session may do now, per MuPDF (owner rights grant everything).
export function grantedPermissions(document: Mupdf.PDFDocument): Readonly<Record<PdfPermission, boolean>> {
	const granted: Record<PdfPermission, boolean> = {
		print: false,
		printHq: false,
		copy: false,
		edit: false,
		annotate: false,
		form: false,
		assemble: false,
		accessibility: false
	}

	for (const [ours, theirs] of PERMISSIONS) granted[ours] = document.hasPermission(theirs)

	return granted
}

// The document's protection as the editor reports it (the session's snapshot). Reads the trailer only.
export function securitySummary(document: Mupdf.PDFDocument, held: PdfHeldAccess): PdfSecuritySummary {
	const state = securityState(document, held)

	return {
		method: state.method,
		rc4: isRc4(state.method),
		openPassword: held.openPassword,
		permissions: state.permissions,
		restricted: state.method !== "none" && isRestricted(state.permissions),
		allowed: allowedFromPermissions(state.permissions),
		ownerAccess: hasOwnerAccess(state),
		upgrade: isRc4(state.method) ? upgradeRefusal(state) : "notRc4"
	}
}

// The document's security as the dialog and the tools read it. Reads the trailer only; touches no pages.
export function describeSecurity(document: Mupdf.PDFDocument, held: PdfHeldAccess): PdfSecurityDescription {
	return { ...securitySummary(document, held), granted: grantedPermissions(document) }
}

// What a freshly opened document is authenticated with: call once, right after opening and before any unlock (it
// authenticates again, replacing what the open did). `accepted`: the password the viewer accepted, null when the
// document opened without one. Tries it as typed, then SASLprep'd. Null when it unlocks nothing (the document stays
// locked). Never call `needsPassword()` on the document afterwards: it tries the empty password, dropping access.
export function heldAccessAtOpen(document: Mupdf.PDFDocument, accepted: string | null): PdfHeldAccess | null {
	if (encryptDictionary(document) === null) return { password: "", bits: 0, openPassword: false }

	const openPassword = document.needsPassword()

	for (const candidate of passwordCandidates(accepted ?? "")) {
		const bits = document.authenticatePassword(candidate)

		if (bits !== 0) return { password: candidate, bits, openPassword }
	}

	return null
}

// Unlocks owner rights with a typed owner password (as typed, then SASLprep'd). On success the document has owner
// rights (hasPermission grants everything) and the result replaces the session's held access. On failure (a wrong
// password, or the password to open) the document is authenticated with `held` again, since MuPDF drops all access on
// a failed attempt, and the result is null. Touches no pages.
export function unlockOwner(document: Mupdf.PDFDocument, typed: string, held: PdfHeldAccess): PdfHeldAccess | null {
	if (encryptDictionary(document) === null) return held

	for (const candidate of passwordCandidates(typed)) {
		const bits = document.authenticatePassword(candidate)

		if ((bits & PDF_AUTH_OWNER) !== 0) return { password: candidate, bits, openPassword: held.openPassword }
	}

	if (held.bits !== 0) document.authenticatePassword(held.password)

	return null
}

// The write options for `choice` (see planSecurity), or why it is refused. The save pipeline merges them with its own
// options through composeWriteOptions and passes that object to `saveToBuffer`. Touches no pages.
export function planDocumentSecurity(document: Mupdf.PDFDocument, held: PdfHeldAccess, choice: PdfSecurityChoice): PdfSecurityPlan {
	return planSecurity(securityState(document, held), choice)
}
