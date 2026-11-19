import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import { DocxEngine, type DocxEngineServices } from "@filen/office/dom/docx"
import { buildDocx } from "./docxSynthetic"

// Every character half an em wide.
const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

const services: DocxEngineServices = {
	fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
	replayFonts: false,
	fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
	measurer,
	yield: () => Promise.resolve(),
	sliceMs: Infinity
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

// Embeds a regular face for "Doc Font" that is no font at all, and draws text in it.
const DOCUMENT = buildDocx({
	body: '<w:p><w:r><w:rPr><w:rFonts w:ascii="Doc Font" w:hAnsi="Doc Font"/></w:rPr><w:t>Text</w:t></w:r></w:p>',
	parts: [
		{
			name: "word/fontTable.xml",
			contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="${W}" xmlns:r="${R}"><w:font w:name="Doc Font"><w:embedRegular r:id="rIdE"/></w:font></w:fonts>`
		},
		{
			name: "word/_rels/fontTable.xml.rels",
			data:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				`<Relationship Id="rIdE" Type="${R}/font" Target="fonts/font1.ttf"/></Relationships>`
		},
		{ name: "word/fonts/font1.ttf", data: new Uint8Array(1000) }
	],
	relationships: [{ id: "rIdF", type: "fontTable", target: "fontTable.xml" }]
})

describe("embedded font failures", () => {
	it("reach the realm's log once, as a code with the family and style", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		try {
			const engine = new DocxEngine(bytesSource(DOCUMENT), services, () => undefined)

			await engine.run()
			engine.close()

			expect(warn.mock.calls.filter(call => call[0] === "Embedded font not used")).toEqual([
				["Embedded font not used", { code: "notSfnt", family: "Doc Font", bold: false, italic: false }]
			])
		} finally {
			warn.mockRestore()
		}
	})
})
