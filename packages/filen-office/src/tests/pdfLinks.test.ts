import { describe, expect, it, vi } from "vitest"
import { pdfLinks, resolveDestination, type PdfDocument } from "../dom/pdf/index"

const RECT = [10, 20, 110, 40]

function link(fields: object): object {
	return { subtype: "Link", rect: RECT, ...fields }
}

describe("pdfLinks", () => {
	it("keeps an external link the shared policy allows", () => {
		expect(pdfLinks([link({ url: "https://example.com/a?b#c" })])).toEqual([
			{ kind: "external", rect: RECT, url: "https://example.com/a?b#c" }
		])
	})

	it("judges the raw URI when pdf.js left a scheme of the shared policy unset", () => {
		expect(pdfLinks([link({ unsafeUrl: "sms:+15550100" }), link({ unsafeUrl: "geo:52.5,13.4" })])).toEqual([
			{ kind: "external", rect: RECT, url: "sms:+15550100" },
			{ kind: "external", rect: RECT, url: "geo:52.5,13.4" }
		])
	})

	it("drops script, data, file and relative URIs and a web URL with no host", () => {
		const refused = [
			"javascript:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html,x",
			"file:///etc/passwd",
			"relative/path",
			"https:/nohost",
			"ftp://example.com"
		]

		expect(pdfLinks(refused.map(unsafeUrl => link({ unsafeUrl })))).toEqual([])
		expect(pdfLinks(refused.map(url => link({ url })))).toEqual([])
	})

	it("narrows the policy with the host's own check, never widening it", () => {
		const allow = vi.fn((url: string) => url.startsWith("https://"))

		expect(
			pdfLinks([link({ url: "mailto:a@example.com" }), link({ url: "https://example.com" }), link({ url: "javascript:x" })], allow)
		).toEqual([{ kind: "external", rect: RECT, url: "https://example.com" }])
		expect(allow.mock.calls).toEqual([["mailto:a@example.com"], ["https://example.com"]])
	})

	it("keeps in-document destinations, named or explicit", () => {
		const explicit = [{ num: 7, gen: 0 }, { name: "XYZ" }, 0, 792, null]

		expect(pdfLinks([link({ dest: "chapter.2" }), link({ dest: explicit })])).toEqual([
			{ kind: "internal", rect: RECT, dest: "chapter.2" },
			{ kind: "internal", rect: RECT, dest: explicit }
		])
	})

	it("drops other subtypes, actions without a target and malformed rectangles", () => {
		expect(
			pdfLinks([
				{ subtype: "Widget", url: "https://example.com", rect: RECT },
				link({ action: "Print" }),
				link({ dest: "" }),
				link({ dest: [] }),
				{ subtype: "Link", url: "https://example.com", rect: [0, 0, 1] },
				{ subtype: "Link", url: "https://example.com", rect: [0, 0, 1, Number.NaN] },
				{ subtype: "Link", url: "https://example.com", rect: "0 0 1 1" },
				null,
				"Link",
				42
			])
		).toEqual([])
	})
})

function document(fields: Partial<PdfDocument>): PdfDocument {
	return {
		numPages: 5,
		getPage: () => Promise.reject(new Error("unused")),
		getDestination: () => Promise.resolve(null),
		getPageIndex: () => Promise.resolve(0),
		getOutline: () => Promise.resolve(null),
		getMetadata: () => Promise.resolve({ info: {} }),
		...fields
	}
}

describe("resolveDestination", () => {
	it("looks a named destination up, then its page", async () => {
		const ref = { num: 12, gen: 0 }
		const getDestination = vi.fn(() => Promise.resolve([ref, { name: "Fit" }]))
		const getPageIndex = vi.fn(() => Promise.resolve(3))

		await expect(resolveDestination(document({ getDestination, getPageIndex }), "intro")).resolves.toBe(4)
		expect(getDestination).toHaveBeenCalledWith("intro")
		expect(getPageIndex).toHaveBeenCalledWith(ref)
	})

	it("resolves an explicit destination's page reference, or a page index written in its place", async () => {
		await expect(resolveDestination(document({ getPageIndex: () => Promise.resolve(1) }), [{ num: 3, gen: 0 }])).resolves.toBe(2)
		await expect(resolveDestination(document({}), [2, { name: "XYZ" }])).resolves.toBe(3)
	})

	it("gives null for a destination that points nowhere", async () => {
		await expect(resolveDestination(document({}), "missing")).resolves.toBeNull()
		await expect(resolveDestination(document({}), [9])).resolves.toBeNull()
		await expect(resolveDestination(document({}), [-1])).resolves.toBeNull()
		await expect(
			resolveDestination(document({ getPageIndex: () => Promise.reject(new Error("bad ref")) }), [{ num: 1, gen: 0 }])
		).resolves.toBeNull()
		await expect(resolveDestination(document({ getDestination: () => Promise.reject(new Error("bad")) }), "x")).resolves.toBeNull()
	})
})
