import { describe, expect, it } from "vitest"
import { PDF_PERMISSIONS_ALL, type PdfAllowed } from "@filen/office/core/pdfedit/security"
import type { PdfSecurityDescription } from "@filen/office/dom/pdfedit/security"
import {
	changesSomething,
	currentMode,
	initialForm,
	isLocked,
	protectChoice,
	type ProtectForm
} from "@/features/pdf/security/security.logic"

const ALL: PdfAllowed = { print: true, copy: true, change: true }
const GRANTED = { print: true, printHq: true, copy: true, edit: true, annotate: true, form: true, assemble: true, accessibility: true }

function description(overrides: Partial<PdfSecurityDescription>): PdfSecurityDescription {
	return {
		method: "none",
		rc4: false,
		openPassword: false,
		permissions: PDF_PERMISSIONS_ALL,
		restricted: false,
		allowed: ALL,
		ownerAccess: true,
		granted: GRANTED,
		upgrade: "notRc4",
		...overrides
	}
}

const plain = description({})
const opened = description({ method: "aes-256", openPassword: true })
const restricted = description({ method: "aes-256", restricted: true, allowed: { print: true, copy: false, change: false } })

function form(current: PdfSecurityDescription, overrides: Partial<ProtectForm>): ProtectForm {
	return { ...initialForm(current), ...overrides }
}

describe("Protect document rules", () => {
	it("starts from the document's protection", () => {
		expect(currentMode(plain)).toBe("none")
		expect(currentMode(opened)).toBe("open")
		expect(currentMode(restricted)).toBe("restrict")
		expect(initialForm(restricted).allowed).toEqual(restricted.allowed)
	})

	it("sets a password to open typed twice", () => {
		expect(protectChoice(plain, form(plain, { mode: "open", password: "pässwörd", confirm: "pässwörd" })).choice).toEqual({
			kind: "open",
			password: "pässwörd"
		})
		expect(protectChoice(plain, form(plain, { mode: "open", password: "a", confirm: "b" }))).toMatchObject({
			choice: null,
			errors: { password: "mismatch" }
		})
		expect(protectChoice(plain, form(plain, { mode: "open" })).choice).toBeNull()
	})

	it("flags passwords SASLprep refuses", () => {
		expect(protectChoice(plain, form(plain, { mode: "open", password: "a\u0007", confirm: "a\u0007" }))).toMatchObject({
			choice: null,
			errors: { password: "refused" }
		})
	})

	it("restricts with an owner password, an optional open password that differs, and the allowed actions", () => {
		const allowed = { print: false, copy: true, change: false }

		expect(protectChoice(plain, form(plain, { mode: "restrict", ownerPassword: "o", ownerConfirm: "o", allowed })).choice).toEqual({
			kind: "restrict",
			ownerPassword: "o",
			openPassword: null,
			allowed
		})
		expect(
			protectChoice(
				plain,
				form(plain, { mode: "restrict", ownerPassword: "ﬁ", ownerConfirm: "ﬁ", openPassword: "fi", openConfirm: "fi" })
			)
		).toMatchObject({ choice: null, errors: { same: true } })
		expect(
			protectChoice(plain, form(plain, { mode: "restrict", ownerPassword: "o", ownerConfirm: "o", openConfirm: "x" })).choice
		).toBeNull()
	})

	it("keeps the current passwords when left blank, so nothing is applied", () => {
		const keep = protectChoice(opened, initialForm(opened)).choice

		expect(keep).toEqual({ kind: "keep" })
		expect(changesSomething(keep)).toBe(false)
		expect(protectChoice(restricted, initialForm(restricted)).choice).toEqual({ kind: "keep" })
		expect(protectChoice(restricted, form(restricted, { allowed: ALL })).choice).toBeNull()
	})

	it("removes encryption with owner access only", () => {
		expect(protectChoice(opened, form(opened, { mode: "none" })).choice).toEqual({ kind: "remove" })

		const locked = description({ method: "aes-256", restricted: true, ownerAccess: false })

		expect(isLocked(locked)).toBe(true)
		expect(protectChoice(locked, form(locked, { mode: "none" })).choice).toEqual({ kind: "keep" })
	})

	it("offers the RC4 upgrade when it is possible, and applies it when nothing else changes", () => {
		const rc4 = description({ method: "rc4-128", rc4: true, openPassword: true, upgrade: null })
		const stuck = description({ method: "rc4-128", rc4: true, restricted: true, ownerAccess: false, upgrade: "ownerRequired" })

		expect(initialForm(rc4).upgrade).toBe(true)
		expect(protectChoice(rc4, initialForm(rc4)).choice).toEqual({ kind: "upgrade" })
		expect(protectChoice(rc4, form(rc4, { upgrade: false })).choice).toEqual({ kind: "keep" })
		expect(initialForm(stuck).upgrade).toBe(false)
		expect(protectChoice(stuck, form(stuck, { upgrade: true })).choice).toEqual({ kind: "keep" })
	})
})
