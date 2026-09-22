import { describe, expect, it } from "vitest"
import { externalLinkDomain, shouldInterceptLinkClick } from "@/features/chats/lib/linkTrust.logic"

// Version 4 (third group starts "4"), variant 8 (fourth "8"), and a 64-hex-char (32-byte) key —
// @filen/shared's parseFilenPublicLink, which this recognition ultimately delegates to, hard-rejects
// any other uuid variant or decoded key length.
const FILEN_UUID = "11111111-1111-4111-8111-111111111111"
const FILEN_KEY_HEX = "3031323334353637383961626364656630313233343536373839616263646566"

describe("externalLinkDomain", () => {
	it("resolves the lowercased hostname for a genuine external https url", () => {
		expect(externalLinkDomain("https://Example.com/path?x=1")).toBe("example.com")
	})

	it("resolves the hostname for a genuine external http url", () => {
		expect(externalLinkDomain("http://example.org")).toBe("example.org")
	})

	it("is null for a Filen public FILE link — same-domain, never gated", () => {
		expect(externalLinkDomain(`https://app.filen.io/#/d/${FILEN_UUID}%23${FILEN_KEY_HEX}`)).toBeNull()
	})

	it("is null for a Filen public DIRECTORY link", () => {
		expect(externalLinkDomain(`https://app.filen.io/#/f/${FILEN_UUID}%23${FILEN_KEY_HEX}`)).toBeNull()
	})

	it("is null for an unparseable url", () => {
		expect(externalLinkDomain("not a url")).toBeNull()
	})

	it("distinguishes subdomains as separate domains (each gets its own one-time confirmation)", () => {
		expect(externalLinkDomain("https://cdn.example.com/a.png")).toBe("cdn.example.com")
		expect(externalLinkDomain("https://example.com/a.png")).toBe("example.com")
	})
})

describe("shouldInterceptLinkClick", () => {
	it("intercepts a not-yet-trusted external domain", () => {
		expect(shouldInterceptLinkClick("example.com", new Set())).toBe(true)
	})

	it("does not intercept a domain already in the trusted set", () => {
		expect(shouldInterceptLinkClick("example.com", new Set(["example.com"]))).toBe(false)
	})

	it("does not intercept when there is no domain to gate on (a null domain — Filen link or unparseable)", () => {
		expect(shouldInterceptLinkClick(null, new Set())).toBe(false)
	})

	it("is case/entry-sensitive to the trusted set's own contents — a different-cased entry doesn't match", () => {
		// externalLinkDomain always normalizes to lowercase before this is ever called, so a mismatch here
		// would only happen if the trusted set itself somehow held a mixed-case entry — this asserts the
		// function does an exact Set lookup, not a second case-fold of its own.
		expect(shouldInterceptLinkClick("example.com", new Set(["Example.com"]))).toBe(true)
	})
})
