import { describe, expect, it } from "vitest"
import { blankOdpParts } from "../core/templates/odp"
import { blankPptxParts } from "../core/templates/pptx"
import { FILEN_THEME } from "../core/templates/themes/model"
import { WIDESCREEN } from "../core/templates/themes/pptx"
import { odpGalleryMaster } from "../core/templates/themes/odp"
import { assertWellFormed, encodeUtf8, parseXml } from "../core/xml/index"

// Text the template builders take from their callers is written as well-formed XML: a code unit XML cannot carry
// becomes U+FFFD.

const ILLEGAL = "A\u0001B￿"

function wellFormed(markup: string): void {
	assertWellFormed(parseXml(encodeUtf8(markup)))
}

function partText(parts: readonly (readonly unknown[])[], name: string): string {
	const markup = parts.find(part => part[0] === name)?.[1]

	if (typeof markup !== "string") throw new Error(`no part ${name}`)

	return markup
}

describe("template text escaping", () => {
	it("writes a pptx title with an XML-illegal character as U+FFFD", () => {
		const slide = partText(blankPptxParts({ title: ILLEGAL }), "ppt/slides/slide1.xml")

		expect(() => {
			wellFormed(slide)
		}).not.toThrow()
		expect(slide).toContain("<a:t>A�B�</a:t>")
	})

	it("writes an odp title with an XML-illegal character as U+FFFD", () => {
		const content = partText(blankOdpParts({ locale: "en-US", title: ILLEGAL }), "content.xml")

		expect(() => {
			wellFormed(content)
		}).not.toThrow()
		expect(content).toContain(">A�B�</text:p>")
	})

	it("writes a gallery master's names with an XML-illegal character as U+FFFD", () => {
		const master = odpGalleryMaster(FILEN_THEME, 0, WIDESCREEN, ILLEGAL, ILLEGAL)

		expect(() => {
			wellFormed(master.document)
		}).not.toThrow()
		expect(master.master).toContain('style:display-name="A�B�"')
	})
})
