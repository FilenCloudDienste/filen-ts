import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { readRtf } from "../core/rtf/index"
import { latin1 } from "./rtfLatin1"

// An RTF style definition is whole (RTF 1.9.1: a style lists its formatting; \sbasedonN names the style it came
// from): what it leaves at the RTF default stays at that default in the docx style, though its w:basedOn sets it.
// A character style adds to the text's formatting (\additive), so it is written as it is.

async function styles(rtf: string): Promise<Map<string, string>> {
	const result = await readRtf(latin1(rtf))

	if (!result.ok) throw new Error(result.reason)

	const xml = strFromU8(unzipSync(result.docx)["word/styles.xml"] as Uint8Array)
	const out = new Map<string, string>()

	for (const match of xml.matchAll(/<w:style [^>]*w:styleId="([^"]*)"[^>]*>(.*?)<\/w:style>/gu)) out.set(match[1] ?? "", match[2] ?? "")

	return out
}

const SHEET =
	"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\stylesheet" +
	"{\\ql \\li0\\ri0\\fi-720\\sa200\\sl276\\slmult1\\fs22\\b Normal;}" +
	"{\\s21\\qr \\li0\\ri0\\fs22\\sbasedon0 footer;}" +
	"{\\s22\\ql \\li0\\ri0\\sa120\\fs20\\b\\sbasedon0 Strong;}" +
	"{\\*\\cs10 \\additive Default Paragraph Font;}" +
	"{\\*\\cs15 \\additive \\super\\sbasedon10 footnote reference;}}" +
	"\\pard\\plain\\s21 text\\par}"

describe("RTF reader: styles", () => {
	it("writes what a style leaves at the RTF default though its base sets it", async () => {
		const all = await styles(SHEET)
		const footer = [...all.entries()].find(([, xml]) => xml.includes('w:val="footer"'))?.[1] ?? ""

		expect(footer).toContain('<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>')
		expect(footer).toContain('<w:ind w:left="0" w:right="0" w:firstLine="0"/>')
		expect(footer).toContain('<w:b w:val="0"/>')
	})

	it("adds nothing a style sets itself, or a base leaves at the default", async () => {
		const all = await styles(SHEET)
		const strong = [...all.entries()].find(([, xml]) => xml.includes('w:val="Strong"'))?.[1] ?? ""

		expect(strong).toContain('<w:spacing w:after="120" w:line="240" w:lineRule="auto"/>')
		expect(strong).not.toContain('w:b w:val="0"')
		expect(strong).not.toContain("w:before")
	})

	it("writes a character style as it is", async () => {
		const all = await styles(SHEET)
		const reference = [...all.entries()].find(([, xml]) => xml.includes('w:val="footnote reference"'))?.[1] ?? ""

		expect(reference).toContain('<w:vertAlign w:val="superscript"/>')
		expect(reference).not.toContain("<w:sz ")
	})
})
