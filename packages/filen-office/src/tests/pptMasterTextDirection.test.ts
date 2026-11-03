import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { CORPUS_DIR } from "./corpusDir"

// A master text style's direction (TextMasterStyleAtom PF textDirection, [MS-PPT] §2.9.18) is carried into the
// converted master's text styles, and a paragraph that sets its own left-to-right direction under a right-to-left
// master level is written rtl="0", so its bullet stays before its text. poi__41246-1.ppt has an rtl master body level
// under English paragraphs that each set the direction to left to right; lo__tdf77747.ppt has Hebrew paragraphs that
// inherit the rtl level. LibreOffice 7.5 lays the first out left to right and the second right to left.

const ENGLISH = join(CORPUS_DIR, "ppt/poi__41246-1.ppt")
const HEBREW = join(CORPUS_DIR, "ppt/lo__tdf77747.ppt")

async function converted(file: string): Promise<{ readonly styles: string; readonly slide: (index: number) => Promise<string> }> {
	const result = await pptToPptx(bytesSource(new Uint8Array(readFileSync(file))))

	if (result.kind !== "converted") throw new Error(JSON.stringify(result))

	const decoder = new TextDecoder()
	const master = decoder.decode(await result.pptx.read("ppt/slideMasters/slideMaster1.xml"))

	return {
		styles: /<p:bodyStyle><a:lvl1pPr[^>]*>/su.exec(master)?.[0] ?? "",
		slide: async index => decoder.decode(await result.pptx.read(`ppt/slides/slide${String(index)}.xml`))
	}
}

describe("a .ppt master text style with a right-to-left direction", () => {
	it.skipIf(!existsSync(ENGLISH))('writes left-to-right paragraphs under it as rtl="0"', async () => {
		const deck = await converted(ENGLISH)

		expect(deck.styles).toContain('rtl="1"')

		const slide = await deck.slide(2)

		expect(slide).toContain('rtl="0"')
		expect(slide).not.toContain('rtl="1"')
	})

	it.skipIf(!existsSync(HEBREW))("leaves paragraphs that inherit it right to left", async () => {
		const deck = await converted(HEBREW)

		expect(deck.styles).toContain('rtl="1"')

		const slide = await deck.slide(1)

		expect(slide).toContain("סעיף")
		expect(slide).not.toContain('rtl="0"')
	})
})
