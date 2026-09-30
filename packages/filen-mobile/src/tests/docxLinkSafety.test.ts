import { describe, it, expect } from "vitest"

import { classifyUntrustedLinkHref, EXTERNAL_LINK_PROTOCOLS } from "@/lib/untrustedLinks"

describe("classifyUntrustedLinkHref", () => {
	it("blocks a javascript: URL", () => {
		expect(classifyUntrustedLinkHref("javascript:alert(1)").action).toBe("block")
	})

	it("blocks javascript: regardless of casing", () => {
		expect(classifyUntrustedLinkHref("JaVaScRiPt:alert(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("JAVASCRIPT:alert(1)").action).toBe("block")
	})

	it("blocks javascript: obfuscated with the characters a URL parser strips", () => {
		// Browsers drop embedded tabs/newlines and leading control characters while parsing a URL, so
		// all of these navigate as `javascript:` even though none of them matches a literal prefix
		// test. The allowlist fails them closed — this is why it is not a denylist.
		expect(classifyUntrustedLinkHref("java\tscript:alert(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("java\nscript:alert(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("java\rscript:alert(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("\x01javascript:alert(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("\u0000javascript:alert(1)").action).toBe("block")
	})

	it("blocks other script-capable and local-resource schemes", () => {
		expect(classifyUntrustedLinkHref("data:text/html,<script>alert(1)</script>").action).toBe("block")
		expect(classifyUntrustedLinkHref("vbscript:msgbox(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("file:///data/data/io.filen.app/databases/sqlite.db").action).toBe("block")
		expect(classifyUntrustedLinkHref("content://media/external/file/1").action).toBe("block")
		expect(classifyUntrustedLinkHref("intent://scan/#Intent;scheme=zxing;end").action).toBe("block")
		expect(classifyUntrustedLinkHref("blob:https://example.com/uuid").action).toBe("block")
		expect(classifyUntrustedLinkHref("ftp://example.com/file").action).toBe("block")
	})

	it("blocks an empty, whitespace-only or absent href", () => {
		expect(classifyUntrustedLinkHref("").action).toBe("block")
		expect(classifyUntrustedLinkHref("   ").action).toBe("block")
		expect(classifyUntrustedLinkHref(null).action).toBe("block")
		expect(classifyUntrustedLinkHref(undefined).action).toBe("block")
	})

	it("blocks a relative path, which would otherwise resolve against the bundle origin", () => {
		expect(classifyUntrustedLinkHref("../../../etc/passwd").action).toBe("block")
		expect(classifyUntrustedLinkHref("other.html").action).toBe("block")
		expect(classifyUntrustedLinkHref("//evil.example.com").action).toBe("block")
		expect(classifyUntrustedLinkHref("example.com/path").action).toBe("block")
	})

	it("treats a pure fragment as an in-document link", () => {
		expect(classifyUntrustedLinkHref("#bookmark").action).toBe("internal")
		expect(classifyUntrustedLinkHref("  #heading-1  ").action).toBe("internal")
	})

	it("keeps a fragment inert even when its text looks like a scheme", () => {
		// `renderHyperlink` builds these as "#" + the document's anchor name, so the anchor name is
		// attacker-controlled. The leading "#" makes the whole value a fragment identifier.
		expect(classifyUntrustedLinkHref("#javascript:alert(1)").action).toBe("internal")
	})

	it("blocks an allowlisted scheme carrying smuggled trailing content", () => {
		// The allowlist is a prefix test and returns the WHOLE string, so without an interior
		// control-character check these reach Linking.openURL verbatim. The OS resolves by the leading
		// scheme, but the platform should not be handed a URL with raw control characters in it.
		expect(classifyUntrustedLinkHref("tel:+1\njavascript:alert(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("https://example.com\tjavascript:alert(1)").action).toBe("block")
		expect(classifyUntrustedLinkHref("mailto:a@b.c\r\nBcc:victim@x.y").action).toBe("block")
	})

	it("blocks an otherwise-allowlisted URL containing an interior space", () => {
		// A real URL has %20 by this point; an interior literal space means the value was never
		// through a URL serializer.
		expect(classifyUntrustedLinkHref("https://example.com/a b").action).toBe("block")
	})

	it("allows every protocol on the shared allowlist", () => {
		for (const protocol of EXTERNAL_LINK_PROTOCOLS) {
			expect(classifyUntrustedLinkHref(`${protocol}example`).action).toBe("external")
		}
	})

	it("preserves the URL verbatim, including case-sensitive paths and tokens", () => {
		const raw = "https://Example.com/Reset/AbCdEf?Token=XyZ123"
		const classification = classifyUntrustedLinkHref(raw)

		expect(classification).toEqual({
			action: "external",
			url: raw
		})
	})

	it("trims surrounding whitespace on an external URL", () => {
		expect(classifyUntrustedLinkHref("  https://example.com/x  ")).toEqual({
			action: "external",
			url: "https://example.com/x"
		})
	})

	it("classifies the scheme case-insensitively while keeping the URL verbatim", () => {
		expect(classifyUntrustedLinkHref("HTTPS://Example.com/Path")).toEqual({
			action: "external",
			url: "HTTPS://Example.com/Path"
		})
	})

	it("allows an external URL that carries a fragment", () => {
		// renderHyperlink appends "#anchor" to an external target when the link has both.
		expect(classifyUntrustedLinkHref("https://example.com/doc#section")).toEqual({
			action: "external",
			url: "https://example.com/doc#section"
		})
	})
})
