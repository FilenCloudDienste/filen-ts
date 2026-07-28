import { describe, it, expect } from "vitest"

import { classifyDocxLinkHref, parseDocxExternalLink, DOCX_EXTERNAL_LINK_KEY } from "@/components/docxPreview/linkSafety"
import { EXTERNAL_LINK_PROTOCOLS } from "@/components/textEditor/linkUtils"

describe("classifyDocxLinkHref", () => {
	it("blocks a javascript: URL", () => {
		expect(classifyDocxLinkHref("javascript:alert(1)").action).toBe("block")
	})

	it("blocks javascript: regardless of casing", () => {
		expect(classifyDocxLinkHref("JaVaScRiPt:alert(1)").action).toBe("block")
		expect(classifyDocxLinkHref("JAVASCRIPT:alert(1)").action).toBe("block")
	})

	it("blocks javascript: obfuscated with the characters a URL parser strips", () => {
		// Browsers drop embedded tabs/newlines and leading control characters while parsing a URL, so
		// all of these navigate as `javascript:` even though none of them matches a literal prefix
		// test. The allowlist fails them closed — this is why it is not a denylist.
		expect(classifyDocxLinkHref("java\tscript:alert(1)").action).toBe("block")
		expect(classifyDocxLinkHref("java\nscript:alert(1)").action).toBe("block")
		expect(classifyDocxLinkHref("java\rscript:alert(1)").action).toBe("block")
		expect(classifyDocxLinkHref("\x01javascript:alert(1)").action).toBe("block")
		expect(classifyDocxLinkHref("\u0000javascript:alert(1)").action).toBe("block")
	})

	it("blocks other script-capable and local-resource schemes", () => {
		expect(classifyDocxLinkHref("data:text/html,<script>alert(1)</script>").action).toBe("block")
		expect(classifyDocxLinkHref("vbscript:msgbox(1)").action).toBe("block")
		expect(classifyDocxLinkHref("file:///data/data/io.filen.app/databases/sqlite.db").action).toBe("block")
		expect(classifyDocxLinkHref("content://media/external/file/1").action).toBe("block")
		expect(classifyDocxLinkHref("intent://scan/#Intent;scheme=zxing;end").action).toBe("block")
		expect(classifyDocxLinkHref("blob:https://example.com/uuid").action).toBe("block")
	})

	it("blocks an empty, whitespace-only or absent href", () => {
		expect(classifyDocxLinkHref("").action).toBe("block")
		expect(classifyDocxLinkHref("   ").action).toBe("block")
		expect(classifyDocxLinkHref(null).action).toBe("block")
		expect(classifyDocxLinkHref(undefined).action).toBe("block")
	})

	it("blocks a relative path, which would otherwise resolve against the bundle origin", () => {
		expect(classifyDocxLinkHref("../../../etc/passwd").action).toBe("block")
		expect(classifyDocxLinkHref("other.html").action).toBe("block")
		expect(classifyDocxLinkHref("//evil.example.com").action).toBe("block")
	})

	it("treats a pure fragment as an in-document link", () => {
		expect(classifyDocxLinkHref("#bookmark").action).toBe("internal")
		expect(classifyDocxLinkHref("  #heading-1  ").action).toBe("internal")
	})

	it("keeps a fragment inert even when its text looks like a scheme", () => {
		// `renderHyperlink` builds these as "#" + the document's anchor name, so the anchor name is
		// attacker-controlled. The leading "#" makes the whole value a fragment identifier.
		expect(classifyDocxLinkHref("#javascript:alert(1)").action).toBe("internal")
	})

	it("blocks an allowlisted scheme carrying smuggled trailing content", () => {
		// The allowlist is a prefix test and returns the WHOLE string, so without an interior
		// control-character check these reach Linking.openURL verbatim. The OS resolves by the leading
		// scheme, but the platform should not be handed a URL with raw control characters in it.
		expect(classifyDocxLinkHref("tel:+1\njavascript:alert(1)").action).toBe("block")
		expect(classifyDocxLinkHref("https://example.com\tjavascript:alert(1)").action).toBe("block")
		expect(classifyDocxLinkHref("mailto:a@b.c\r\nBcc:victim@x.y").action).toBe("block")
	})

	it("blocks an otherwise-allowlisted URL containing an interior space", () => {
		// A real URL has %20 by this point; an interior literal space means the value was never
		// through a URL serializer.
		expect(classifyDocxLinkHref("https://example.com/a b").action).toBe("block")
	})

	it("allows every protocol on the shared allowlist", () => {
		for (const protocol of EXTERNAL_LINK_PROTOCOLS) {
			expect(classifyDocxLinkHref(`${protocol}example`).action).toBe("external")
		}
	})

	it("preserves the URL verbatim, including case-sensitive paths and tokens", () => {
		const raw = "https://Example.com/Reset/AbCdEf?Token=XyZ123"
		const classification = classifyDocxLinkHref(raw)

		expect(classification).toEqual({
			action: "external",
			url: raw
		})
	})

	it("trims surrounding whitespace on an external URL", () => {
		expect(classifyDocxLinkHref("  https://example.com/x  ")).toEqual({
			action: "external",
			url: "https://example.com/x"
		})
	})

	it("classifies the scheme case-insensitively while keeping the URL verbatim", () => {
		expect(classifyDocxLinkHref("HTTPS://Example.com/Path")).toEqual({
			action: "external",
			url: "HTTPS://Example.com/Path"
		})
	})

	it("allows an external URL that carries a fragment", () => {
		// renderHyperlink appends "#anchor" to an external target when the link has both.
		expect(classifyDocxLinkHref("https://example.com/doc#section")).toEqual({
			action: "external",
			url: "https://example.com/doc#section"
		})
	})
})

describe("parseDocxExternalLink", () => {
	function envelope(url: unknown): unknown {
		return {
			[DOCX_EXTERNAL_LINK_KEY]: {
				url
			}
		}
	}

	it("returns the URL for a well-formed envelope", () => {
		expect(parseDocxExternalLink(envelope("https://example.com"))).toBe("https://example.com")
	})

	it("re-validates the URL rather than trusting the WebView", () => {
		// The WebView is the untrusted side of this bridge and the value reaches Linking.openURL, so a
		// payload that skipped the DOM-side check must still be rejected here.
		expect(parseDocxExternalLink(envelope("javascript:alert(1)"))).toBeNull()
		expect(parseDocxExternalLink(envelope("file:///etc/passwd"))).toBeNull()
		expect(parseDocxExternalLink(envelope("#fragment"))).toBeNull()
		expect(parseDocxExternalLink(envelope(""))).toBeNull()
	})

	it("returns null for a non-envelope message", () => {
		expect(parseDocxExternalLink(null)).toBeNull()
		expect(parseDocxExternalLink(undefined)).toBeNull()
		expect(parseDocxExternalLink("a string")).toBeNull()
		expect(parseDocxExternalLink(42)).toBeNull()
		expect(parseDocxExternalLink({})).toBeNull()
		expect(parseDocxExternalLink({ __filenLog: { level: "warn", message: "x" } })).toBeNull()
	})

	it("returns null for a malformed envelope payload", () => {
		expect(parseDocxExternalLink({ [DOCX_EXTERNAL_LINK_KEY]: null })).toBeNull()
		expect(parseDocxExternalLink({ [DOCX_EXTERNAL_LINK_KEY]: "https://example.com" })).toBeNull()
		expect(parseDocxExternalLink(envelope(undefined))).toBeNull()
		expect(parseDocxExternalLink(envelope(123))).toBeNull()
	})
})
