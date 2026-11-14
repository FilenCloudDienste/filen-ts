import { describe, expect, it } from "vitest"
import {
	allowedFromPermissions,
	composeWriteOptions,
	encryptionMethod,
	isRestricted,
	passwordCandidates,
	PDF_ALLOW_NONE,
	PDF_AUTH_OWNER,
	PDF_AUTH_USER,
	PDF_PERMISSIONS_ALL,
	permissionsValue,
	planSecurity,
	preparedPassword,
	upgradeRefusal,
	type PdfHeldAccess,
	type PdfSecurityState,
	type PdfSecurityWriteOptions
} from "../../core/pdfedit/security"

// The pure security rules: method detection, /P values, and what each Protect choice writes or why it is refused.

function state(overrides: Partial<Omit<PdfSecurityState, "held">> & { held?: Partial<PdfHeldAccess> }): PdfSecurityState {
	return {
		method: overrides.method ?? "aes-256",
		permissions: overrides.permissions ?? PDF_PERMISSIONS_ALL,
		held: { password: "", bits: PDF_AUTH_USER, openPassword: false, ...overrides.held }
	}
}

const plain = state({ method: "none", held: { bits: 0 } })

describe("encryptionMethod", () => {
	it.each([
		[null, "none"],
		[{ filter: "Standard", v: 1, r: 2, length: null, cfm: null }, "rc4-40"],
		[{ filter: "Standard", v: 2, r: 3, length: 128, cfm: null }, "rc4-128"],
		[{ filter: "Standard", v: 2, r: 3, length: 40, cfm: null }, "rc4-40"],
		[{ filter: "Standard", v: 4, r: 4, length: 128, cfm: "V2" }, "rc4-128"],
		[{ filter: "Standard", v: 4, r: 4, length: 128, cfm: "AESV2" }, "aes-128"],
		[{ filter: "Standard", v: 5, r: 6, length: 256, cfm: "AESV3" }, "aes-256"],
		[{ filter: "Standard", v: 4, r: 4, length: 128, cfm: "None" }, "unsupported"],
		[{ filter: "Adobe.PubSec", v: 5, r: 6, length: 256, cfm: "AESV3" }, "unsupported"],
		[{ filter: "Standard", v: 3, r: 3, length: 128, cfm: null }, "unsupported"]
	] as const)("%j → %s", (fields, method) => {
		expect(encryptionMethod(fields)).toBe(method)
	})
})

describe("permissions", () => {
	it("denies everything but accessibility with nothing allowed, and keeps the reserved bits", () => {
		expect(permissionsValue(PDF_ALLOW_NONE)).toBe(-3904 + 512)
		expect(permissionsValue({ print: true, copy: true, change: true })).toBe(PDF_PERMISSIONS_ALL)
		expect(isRestricted(PDF_PERMISSIONS_ALL)).toBe(false)
		expect(isRestricted(permissionsValue(PDF_ALLOW_NONE))).toBe(true)
	})

	it.each([
		{ print: true, copy: false, change: false },
		{ print: false, copy: true, change: false },
		{ print: false, copy: false, change: true },
		{ print: true, copy: true, change: false }
	])("round-trips %j", allowed => {
		expect(allowedFromPermissions(permissionsValue(allowed))).toEqual(allowed)
		expect(isRestricted(permissionsValue(allowed))).toBe(true)
	})

	it("reads a /P that grants only low-quality printing as no printing", () => {
		expect(allowedFromPermissions(-3904 | 4).print).toBe(false)
	})
})

describe("passwords", () => {
	it("prepares with SASLprep and refuses what it prohibits", () => {
		expect(preparedPassword("ﬁx")).toEqual({ ok: true, value: "fix" })
		expect(preparedPassword("pässwörd")).toEqual({ ok: true, value: "pässwörd" })
		expect(preparedPassword("tab\there")).toEqual({ ok: false, reason: "passwordRefused" })
		expect(preparedPassword("")).toEqual({ ok: false, reason: "emptyPassword" })
		expect(preparedPassword("­")).toEqual({ ok: false, reason: "emptyPassword" })
	})

	it("cuts at 127 UTF-8 bytes on a character boundary", () => {
		const prepared = preparedPassword("é".repeat(100))

		expect(prepared).toEqual({ ok: true, value: "é".repeat(63) })
	})

	it("tries a password as typed, then prepared", () => {
		expect(passwordCandidates("ﬁx")).toEqual(["ﬁx", "fix"])
		expect(passwordCandidates("plain")).toEqual(["plain"])
		expect(passwordCandidates("")).toEqual([""])
	})
})

describe("planSecurity", () => {
	it("keeps encryption on a plain save, whatever the access", () => {
		expect(planSecurity(state({ method: "rc4-128", held: { bits: 0 } }), { kind: "keep" })).toEqual({
			ok: true,
			options: { encrypt: "keep" },
			changes: false
		})
	})

	it("sets a password to open as AES-256 with the same owner password and nothing restricted", () => {
		expect(planSecurity(plain, { kind: "open", password: 'a,b=c"d' })).toEqual({
			ok: true,
			changes: true,
			options: { encrypt: "aes-256", "user-password": 'a,b=c"d', "owner-password": 'a,b=c"d', permissions: PDF_PERMISSIONS_ALL }
		})
	})

	it("restricts with or without a password to open, never with equal passwords", () => {
		const allowed = { print: true, copy: false, change: false }

		expect(planSecurity(plain, { kind: "restrict", ownerPassword: "owner", openPassword: null, allowed })).toMatchObject({
			ok: true,
			options: { encrypt: "aes-256", "user-password": "", "owner-password": "owner", permissions: permissionsValue(allowed) }
		})
		expect(planSecurity(plain, { kind: "restrict", ownerPassword: "owner", openPassword: "open", allowed })).toMatchObject({
			ok: true,
			options: { "user-password": "open", "owner-password": "owner" }
		})
		expect(planSecurity(plain, { kind: "restrict", ownerPassword: "ﬁ", openPassword: "fi", allowed })).toEqual({
			ok: false,
			reason: "samePasswords"
		})
		expect(planSecurity(plain, { kind: "restrict", ownerPassword: "", openPassword: null, allowed })).toEqual({
			ok: false,
			reason: "emptyPassword"
		})
	})

	it("needs owner access to change or remove encryption", () => {
		const user = state({ held: { password: "u", bits: PDF_AUTH_USER, openPassword: true } })
		const owner = state({ held: { password: "o", bits: PDF_AUTH_OWNER, openPassword: true } })

		expect(planSecurity(user, { kind: "remove" })).toEqual({ ok: false, reason: "ownerRequired" })
		expect(planSecurity(user, { kind: "open", password: "new" })).toEqual({ ok: false, reason: "ownerRequired" })
		expect(planSecurity(owner, { kind: "remove" })).toEqual({ ok: true, options: { encrypt: "none" }, changes: true })
		expect(planSecurity(plain, { kind: "remove" })).toEqual({ ok: true, options: { encrypt: "keep" }, changes: false })
	})

	it("keeps an unsupported handler only", () => {
		const other = state({ method: "unsupported", held: { bits: PDF_AUTH_OWNER } })

		expect(planSecurity(other, { kind: "remove" })).toEqual({ ok: false, reason: "unsupported" })
		expect(planSecurity(other, { kind: "keep" }).ok).toBe(true)
	})
})

describe("RC4 upgrade", () => {
	const restricted = permissionsValue(PDF_ALLOW_NONE)

	it("refuses files that do not use RC4", () => {
		expect(upgradeRefusal(state({ method: "aes-128" }))).toBe("notRc4")
	})

	it("reuses the held open password for both when nothing is restricted", () => {
		const held = { password: "u", bits: PDF_AUTH_USER, openPassword: true }

		expect(planSecurity(state({ method: "rc4-128", held }), { kind: "upgrade" })).toEqual({
			ok: true,
			changes: true,
			options: { encrypt: "aes-256", "user-password": "u", "owner-password": "u", permissions: PDF_PERMISSIONS_ALL }
		})
	})

	it("needs the owner password to carry restrictions, and the open password to carry that", () => {
		expect(
			upgradeRefusal(
				state({ method: "rc4-40", permissions: restricted, held: { password: "u", bits: PDF_AUTH_USER, openPassword: true } })
			)
		).toBe("ownerRequired")
		expect(upgradeRefusal(state({ method: "rc4-128", held: { password: "o", bits: PDF_AUTH_OWNER, openPassword: true } }))).toBe(
			"openPasswordUnknown"
		)
		expect(
			planSecurity(
				state({ method: "rc4-128", permissions: restricted, held: { password: "o", bits: PDF_AUTH_OWNER, openPassword: false } }),
				{
					kind: "upgrade"
				}
			)
		).toMatchObject({ ok: true, options: { "user-password": "", "owner-password": "o", permissions: restricted } })
		expect(
			planSecurity(
				state({
					method: "rc4-128",
					permissions: restricted,
					held: { password: "both", bits: PDF_AUTH_USER | PDF_AUTH_OWNER, openPassword: true }
				}),
				{ kind: "upgrade" }
			)
		).toMatchObject({ ok: true, options: { "user-password": "both", "owner-password": "both" } })
	})
})

describe("composeWriteOptions", () => {
	it("merges the pipeline's options with the security options", () => {
		expect(composeWriteOptions("garbage=compact,compress, objstms", { encrypt: "keep" })).toEqual({
			garbage: "compact",
			compress: "yes",
			objstms: "yes",
			encrypt: "keep"
		})
	})

	it("refuses encryption keys in the base and an incremental encryption change", () => {
		expect(() => composeWriteOptions("garbage=compact,encrypt=none", { encrypt: "keep" })).toThrow()
		expect(() => composeWriteOptions("incremental", { encrypt: "none" })).toThrow()
		expect(composeWriteOptions("incremental", { encrypt: "keep" })).toEqual({ incremental: "yes", encrypt: "keep" })
	})

	it("refuses a base that is not plain words, so no user value can ride in it", () => {
		for (const base of ["user-password=a", "garbage=compact,garbage=none", 'garbage="x"', "garbage=a b", '{"encrypt":"none"}', "a=b=c"])
			expect(() => composeWriteOptions(base, { encrypt: "keep" })).toThrow()
	})

	it("refuses security options planSecurity never makes", () => {
		const aes = { encrypt: "aes-256", "user-password": "u", "owner-password": "o", permissions: -4 } as const

		expect(composeWriteOptions("garbage", aes)).toEqual({ garbage: "yes", ...aes })
		for (const password of ["a\tb", "a\u0000", "\ud800x", "x\udc00", "a\u007f"]) {
			expect(() => composeWriteOptions("garbage", { ...aes, "user-password": password })).toThrow()
			expect(() => composeWriteOptions("garbage", { ...aes, "owner-password": password })).toThrow()
		}
		expect(() => composeWriteOptions("garbage", { ...aes, permissions: 1.5 })).toThrow()
		expect(() => composeWriteOptions("garbage", { ...aes, permissions: 2 ** 32 })).toThrow()
		expect(() => composeWriteOptions("garbage", { ...aes, extra: "x" } as unknown as PdfSecurityWriteOptions)).toThrow()
		expect(() => composeWriteOptions("garbage", { encrypt: "rc4-40" } as unknown as PdfSecurityWriteOptions)).toThrow()
		expect(() =>
			composeWriteOptions("garbage", { encrypt: "none", "user-password": "x" } as unknown as PdfSecurityWriteOptions)
		).toThrow()
		// Separators, quotes and braces are only characters inside JSON.
		expect(composeWriteOptions("garbage", { ...aes, "user-password": 'a,encrypt=none","x":"}' })).toMatchObject({
			"user-password": 'a,encrypt=none","x":"}'
		})
	})
})
