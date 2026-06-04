import { describe, it, expect } from "vitest"

import { classifyExternalLinkHref, EXTERNAL_LINK_PROTOCOLS } from "@/components/textEditor/linkUtils"

describe("classifyExternalLinkHref", () => {
	it("preserves the original casing of the URL (never lowercases path/query/tokens)", () => {
		const raw = "https://Example.com/Reset/AbCdEf?Token=XyZ123"

		expect(classifyExternalLinkHref(raw).url).toBe("https://Example.com/Reset/AbCdEf?Token=XyZ123")
	})

	it("trims surrounding whitespace but keeps inner casing", () => {
		expect(classifyExternalLinkHref("  https://X.com/Path  ").url).toBe("https://X.com/Path")
	})

	it("intercepts every allowlisted protocol", () => {
		for (const protocol of EXTERNAL_LINK_PROTOCOLS) {
			expect(classifyExternalLinkHref(`${protocol}example`).intercept).toBe(true)
		}
	})

	it("classifies the protocol case-insensitively while keeping the URL verbatim", () => {
		const result = classifyExternalLinkHref("HTTPS://Example.com/CaseSensitivePath")

		expect(result.intercept).toBe(true)
		expect(result.url).toBe("HTTPS://Example.com/CaseSensitivePath")
	})

	it("does not intercept a non-allowlisted scheme", () => {
		expect(classifyExternalLinkHref("javascript:alert(1)").intercept).toBe(false)
		expect(classifyExternalLinkHref("ftp://example.com/file").intercept).toBe(false)
	})

	it("does not intercept a bare domain without a scheme", () => {
		expect(classifyExternalLinkHref("example.com/path").intercept).toBe(false)
	})
})
