import { preparePassword } from "../pdfwrite/crypto"
import { PdfWriteError } from "../pdfwrite/errors"
import { decodeUtf8 } from "../xml/utf8"

// The rules of a PDF's standard security handler as the editor applies them: what encryption a file uses, which
// changes the session's access allows, and the MuPDF write options for each. Plain data only; the engine side
// (dom/pdfedit/security) reads the document and authenticates.

// How the file is encrypted. "unsupported": a handler other than the standard one (public-key and the like), or
// values no known method has; such a file only keeps its encryption.
export type PdfEncryptionMethod = "none" | "rc4-40" | "rc4-128" | "aes-128" | "aes-256" | "unsupported"

// The entries of the /Encrypt dictionary that tell the method (null: absent). `cfm` is the /CFM of the crypt filter
// strings and streams use (/StmF), V4 and V5 only.
export interface PdfEncryptFields {
	readonly filter: string | null
	readonly v: number | null
	readonly r: number | null
	readonly length: number | null
	readonly cfm: string | null
}

// ISO 32000-2 §7.6.3.2 table 20 (V, Length) and §7.6.5 table 25 (CFM). `dictionary` null: no /Encrypt.
export function encryptionMethod(dictionary: PdfEncryptFields | null): PdfEncryptionMethod {
	if (dictionary === null) return "none"
	if (dictionary.filter !== "Standard") return "unsupported"

	switch (dictionary.v) {
		case 1:
			return "rc4-40"
		case 2:
			return (dictionary.length ?? 40) > 40 ? "rc4-128" : "rc4-40"
		case 4:
			return dictionary.cfm === "AESV2" ? "aes-128" : dictionary.cfm === "V2" ? "rc4-128" : "unsupported"
		case 5:
			return dictionary.cfm === "AESV3" ? "aes-256" : "unsupported"
		default:
			return "unsupported"
	}
}

export function isRc4(method: PdfEncryptionMethod): boolean {
	return method === "rc4-40" || method === "rc4-128"
}

// What a restricted document lets everyone do, as the Protect dialog offers it: printing (at full quality), copying
// text and images, and changes (editing, comments, form filling, page assembly). Accessibility extraction is always
// granted (ISO 32000-2 deprecates denying it).
export interface PdfAllowed {
	readonly print: boolean
	readonly copy: boolean
	readonly change: boolean
}

export const PDF_ALLOW_NONE: PdfAllowed = { print: false, copy: false, change: false }

// /P bits (ISO 32000-2 §7.6.4.2 table 22), as values of the bit's position.
const PRINT = 1 << 2
const MODIFY = 1 << 3
const COPY = 1 << 4
const ANNOTATE = 1 << 5
const FILL = 1 << 8
const ACCESSIBILITY = 1 << 9
const ASSEMBLE = 1 << 10
const PRINT_HIGH = 1 << 11
const CHANGE = MODIFY | ANNOTATE | FILL | ASSEMBLE
const PERMISSION_BITS = PRINT | PRINT_HIGH | COPY | CHANGE | ACCESSIBILITY

// /P of a document that restricts nothing: every bit set except the two low reserved ones.
export const PDF_PERMISSIONS_ALL = ~3

// The signed 32-bit /P for `allowed`: reserved bits set, bits 1-2 clear, accessibility always granted.
export function permissionsValue(allowed: PdfAllowed): number {
	let value = (~3 & ~PERMISSION_BITS) | ACCESSIBILITY

	if (allowed.print) value |= PRINT | PRINT_HIGH
	if (allowed.copy) value |= COPY
	if (allowed.change) value |= CHANGE

	return value | 0
}

// What a /P grants, in the dialog's terms: each needs all of its bits.
export function allowedFromPermissions(permissions: number): PdfAllowed {
	return {
		print: (permissions & (PRINT | PRINT_HIGH)) === (PRINT | PRINT_HIGH),
		copy: (permissions & COPY) === COPY,
		change: (permissions & CHANGE) === CHANGE
	}
}

// Whether a /P denies anything a viewer enforces.
export function isRestricted(permissions: number): boolean {
	return (permissions & PERMISSION_BITS) !== PERMISSION_BITS
}

// fz_authenticate_password's result bits.
export const PDF_AUTH_NONE_NEEDED = 1
export const PDF_AUTH_USER = 2
export const PDF_AUTH_OWNER = 4

// What the session's document is authenticated with. MuPDF has no query for it and any later authentication replaces
// it (a wrong password drops all access; so does `needsPassword()`, which tries the empty password), so the session
// keeps this beside the document, in memory only.
export interface PdfHeldAccess {
	// The password that unlocked the document ("" when it opens without one).
	readonly password: string
	// fz_authenticate_password's bits for it (PDF_AUTH_*); 0 only for a document that is not encrypted.
	readonly bits: number
	// Opening needs a password (the user password is not empty), as read at open.
	readonly openPassword: boolean
}

// The document's security as the rules need it.
export interface PdfSecurityState {
	readonly method: PdfEncryptionMethod
	// /P; PDF_PERMISSIONS_ALL without encryption.
	readonly permissions: number
	readonly held: PdfHeldAccess
}

// Whether the session may change or remove the encryption: owner rights, or no encryption at all.
export function hasOwnerAccess(state: PdfSecurityState): boolean {
	return state.method === "none" || (state.held.bits & PDF_AUTH_OWNER) !== 0
}

// What the user asked for in the Protect dialog.
export type PdfSecurityChoice =
	// Save as the file is: encryption, passwords and permissions unchanged (RC4 stays RC4).
	| { readonly kind: "keep" }
	// Re-encrypt an RC4 file with AES-256 under the same passwords and permissions (see upgradeRefusal).
	| { readonly kind: "upgrade" }
	// No encryption.
	| { readonly kind: "remove" }
	// AES-256 with a password to open (also the owner password: nothing is restricted).
	| { readonly kind: "open"; readonly password: string }
	// AES-256 with an owner password and `allowed`; `openPassword` null (or "") opens without a password.
	| { readonly kind: "restrict"; readonly ownerPassword: string; readonly openPassword: string | null; readonly allowed: PdfAllowed }

export type PdfSecurityRefusal =
	// Changing or removing encryption needs the owner password.
	| "ownerRequired"
	// The upgrade cannot recover the password to open from the owner password; set new passwords instead.
	| "openPasswordUnknown"
	// Upgrade asked for a file that does not use RC4.
	| "notRc4"
	// The file uses a handler or method only kept as is.
	| "unsupported"
	| "emptyPassword"
	// SASLprep prohibits a character of the password.
	| "passwordRefused"
	// The owner password equals the password to open, which would lift the restrictions for everyone who can open it.
	| "samePasswords"
	// The platform cannot prepare passwords (no Unicode normalization).
	| "platform"

// MuPDF write options for the encryption. Passwords are carried only in this object form: `saveToBuffer` serialises
// an object as JSON, which quotes any password, where the comma-separated string form has no escaping at all.
export type PdfSecurityWriteOptions =
	| { readonly encrypt: "keep" }
	| { readonly encrypt: "none" }
	| {
			readonly encrypt: "aes-256"
			readonly "user-password": string
			readonly "owner-password": string
			readonly permissions: number
	  }

export type PdfSecurityPlan =
	| {
			readonly ok: true
			readonly options: PdfSecurityWriteOptions
			// The save changes the encryption: a full rewrite (never incremental), undo history ends, signatures are
			// invalidated, and the session's document carries the new encryption afterwards.
			readonly changes: boolean
	  }
	| { readonly ok: false; readonly reason: PdfSecurityRefusal }

const KEEP: PdfSecurityPlan = { ok: true, options: { encrypt: "keep" }, changes: false }

type Prepared = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: PdfSecurityRefusal }

// A password as the AES-256 handler stores it: SASLprep'd, UTF-8, at most 127 bytes (cut at a character).
export function preparedPassword(password: string): Prepared {
	let bytes: Uint8Array

	try {
		bytes = preparePassword(password)
	} catch (error) {
		if (error instanceof PdfWriteError && error.reason === "password") return { ok: false, reason: "passwordRefused" }
		if (error instanceof PdfWriteError) return { ok: false, reason: "platform" }

		throw error
	}

	const value = decodeUtf8(bytes)

	// SASLprep already prohibits controls; nothing that JSON would escape as \uXXXX may reach MuPDF's option parser.
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)

		if (code < 0x20 || code === 0x7f) return { ok: false, reason: "passwordRefused" }
	}

	return value === "" ? { ok: false, reason: "emptyPassword" } : { ok: true, value }
}

// The strings to try for a typed password, in order: as typed (what a legacy handler and a writer that does not
// prepare stored), then SASLprep'd (what an AES-256 writer that does stored). MuPDF converts each to the handler's
// encoding (PDFDocEncoding up to R4, UTF-8 for R6) but does not apply SASLprep itself.
export function passwordCandidates(typed: string): readonly string[] {
	const prepared = typed === "" ? null : preparedPassword(typed)

	return prepared !== null && prepared.ok && prepared.value !== typed ? [typed, prepared.value] : [typed]
}

// Why `{ kind: "upgrade" }` cannot be planned, or null. Both passwords must be carried over: the held password is
// the only one known, so it must be the owner password where restrictions exist (and the open one where opening needs
// a password; a held password that is both covers both). Without restrictions an owner password adds nothing, so the
// held open password becomes the owner password too (replacing a separate one).
export function upgradeRefusal(state: PdfSecurityState): PdfSecurityRefusal | null {
	if (!isRc4(state.method)) return "notRc4"

	const user = (state.held.bits & PDF_AUTH_USER) !== 0
	const owner = (state.held.bits & PDF_AUTH_OWNER) !== 0
	const restricted = isRestricted(state.permissions)

	if (state.held.openPassword && !user) return "openPasswordUnknown"
	if (restricted && !owner) return "ownerRequired"

	return null
}

function upgradePlan(state: PdfSecurityState): PdfSecurityPlan {
	const refusal = upgradeRefusal(state)

	if (refusal !== null) return { ok: false, reason: refusal }

	const owner = (state.held.bits & PDF_AUTH_OWNER) !== 0 || !isRestricted(state.permissions) ? state.held.password : ""

	return {
		ok: true,
		changes: true,
		options: {
			encrypt: "aes-256",
			"user-password": state.held.openPassword ? state.held.password : "",
			"owner-password": owner,
			permissions: state.permissions | 0
		}
	}
}

// The write options for `choice`, or why it is refused. New encryption is always AES-256 (R6); passwords go through
// SASLprep. Changing anything on an encrypted file needs owner access, except keeping it and the RC4 upgrade.
export function planSecurity(state: PdfSecurityState, choice: PdfSecurityChoice): PdfSecurityPlan {
	if (choice.kind === "keep") return KEEP
	if (state.method === "unsupported") return { ok: false, reason: "unsupported" }
	if (choice.kind === "upgrade") return upgradePlan(state)
	if (!hasOwnerAccess(state)) return { ok: false, reason: "ownerRequired" }

	if (choice.kind === "remove") return state.method === "none" ? KEEP : { ok: true, options: { encrypt: "none" }, changes: true }

	if (choice.kind === "open") {
		const password = preparedPassword(choice.password)

		if (!password.ok) return password

		return {
			ok: true,
			changes: true,
			options: {
				encrypt: "aes-256",
				"user-password": password.value,
				"owner-password": password.value,
				permissions: PDF_PERMISSIONS_ALL
			}
		}
	}

	const owner = preparedPassword(choice.ownerPassword)

	if (!owner.ok) return owner

	let user = ""

	if (choice.openPassword !== null && choice.openPassword !== "") {
		const open = preparedPassword(choice.openPassword)

		if (!open.ok) return open
		if (open.value === owner.value) return { ok: false, reason: "samePasswords" }

		user = open.value
	}

	return {
		ok: true,
		changes: true,
		options: { encrypt: "aes-256", "user-password": user, "owner-password": owner.value, permissions: permissionsValue(choice.allowed) }
	}
}

// The session's held access once a save with `options` succeeded: the saved document's encryption becomes the
// in-memory document's, with owner rights (the user just chose the owner password).
export function heldAfterSave(options: PdfSecurityWriteOptions, previous: PdfHeldAccess): PdfHeldAccess {
	if (options.encrypt === "keep") return previous
	if (options.encrypt === "none") return { password: "", bits: 0, openPassword: false }

	const user = options["user-password"]
	const owner = options["owner-password"]

	return { password: owner, bits: PDF_AUTH_OWNER | (user === owner ? PDF_AUTH_USER : 0), openPassword: user !== "" }
}

// Keys only the security options may set: a base carrying any would let two sources decide the encryption.
const SECURITY_KEYS = new Set(["encrypt", "decrypt", "user-password", "owner-password", "permissions"])

// One `saveToBuffer` options object from the save pipeline's own comma-separated options (no passwords there:
// `garbage=compact,compress` and the like; a bare key means "yes") and the security options. Throws on a base that
// sets an encryption key, and on an incremental base with an encryption change (MuPDF writes a new encryption only
// in a full rewrite).
export function composeWriteOptions(base: string, security: PdfSecurityWriteOptions): Readonly<Record<string, string | number>> {
	const options: Record<string, string | number> = {}

	for (const part of base.split(",")) {
		const entry = part.trim()

		if (entry === "") continue

		const equals = entry.indexOf("=")
		const key = equals < 0 ? entry : entry.slice(0, equals)

		if (SECURITY_KEYS.has(key)) throw new Error(`write option ${key} belongs to the security options`)

		options[key] = equals < 0 ? "yes" : entry.slice(equals + 1)
	}

	const incremental = options["incremental"]

	if (security.encrypt !== "keep" && incremental !== undefined && incremental !== "no")
		throw new Error("an encryption change needs a full rewrite, not an incremental save")

	return { ...options, ...security }
}
