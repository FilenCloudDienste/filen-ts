import { describe, expect, it } from "vitest"
import { headersFor, parseHeaders } from "../main/headers.ts"

const FILE = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'none'; script-src 'self'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/assets/sdk-rs.js
  ! Cache-Control
  Cache-Control: no-cache
`

describe("headersFor", () => {
	const rules = parseHeaders(FILE)

	it("applies the global block to the page", () => {
		expect(headersFor(rules, "/")).toEqual({
			"cross-origin-opener-policy": "same-origin",
			"cross-origin-embedder-policy": "require-corp",
			"content-security-policy": "default-src 'none'; script-src 'self'"
		})
	})

	it("adds the immutable cache rule under /assets", () => {
		expect(headersFor(rules, "/assets/index-abc.js")["cache-control"]).toBe("public, max-age=31536000, immutable")
	})

	it("detaches then replaces a header in file order", () => {
		const headers = headersFor(rules, "/assets/sdk-rs.js")

		expect(headers["cache-control"]).toBe("no-cache")
		expect(headers["cross-origin-embedder-policy"]).toBe("require-corp")
	})

	it("joins a header two matching rules set", () => {
		const joined = parseHeaders("/*\n  Vary: a\n/x\n  Vary: b\n")

		expect(headersFor(joined, "/x")["vary"]).toBe("a, b")
	})

	it("replaces the resource policy on the one asset a wildcard rule names", () => {
		const corp = parseHeaders(
			"/*\n  Cross-Origin-Resource-Policy: same-origin\n/assets/mermaid-frame-*.js\n  ! Cross-Origin-Resource-Policy\n  Cross-Origin-Resource-Policy: cross-origin\n"
		)

		expect(headersFor(corp, "/assets/mermaid-frame-0123abcd.js")["cross-origin-resource-policy"]).toBe("cross-origin")
		expect(headersFor(corp, "/assets/index-abc.js")["cross-origin-resource-policy"]).toBe("same-origin")
		expect(headersFor(corp, "/assets/mermaid-frame-0123abcd.js.map")["cross-origin-resource-policy"]).toBe("same-origin")
	})

	it("does not match a path rule against a longer path", () => {
		expect(headersFor(rules, "/assets/sdk-rs.js.map")["cache-control"]).toBe("public, max-age=31536000, immutable")
	})
})
