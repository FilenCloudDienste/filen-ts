import { describe, expect, it } from "vitest"
import { decodeHtmlEntities } from "@filen/shared"

describe("decodeHtmlEntities", () => {
	it("decodes the references serializers write", () => {
		expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry")
		expect(decodeHtmlEntities("&lt;Header&gt;")).toBe("<Header>")
		expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b")
		expect(decodeHtmlEntities("&quot;it&#39;s it&#x27;s&quot;")).toBe("\"it's it's\"")
	})

	it("decodes one level only, so a typed entity survives its own escaping", () => {
		expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;")
	})

	it("decodes any known name that ends in a semicolon", () => {
		expect(decodeHtmlEntities("&copy; &hellip; &notin; &semi;")).toBe("© … ∉ ;")
	})

	it("leaves a legacy name without its semicolon literal", () => {
		expect(decodeHtmlEntities("cut&copy Save&note Get&quote Issue&#42 R&D")).toBe("cut&copy Save&note Get&quote Issue&#42 R&D")
	})

	it("leaves an unknown name literal, even one that starts with a legacy name", () => {
		expect(decodeHtmlEntities("&copyright; &notafoo; &unknown;")).toBe("&copyright; &notafoo; &unknown;")
	})

	it("returns text without an ampersand as is", () => {
		const text = "plain <b>text</b>"

		expect(decodeHtmlEntities(text)).toBe(text)
	})
})
