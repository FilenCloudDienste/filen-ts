import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { HyphenationLibrary, LineFlag } from "../core/text/index"
import { buildDocx } from "./docxSynthetic"
import { layOut, pageLines } from "./layoutFixtures"

const ASSETS = new URL("../../assets/hyphenation/", import.meta.url)

function library(reads?: string[]): HyphenationLibrary {
	return new HyphenationLibrary({
		read: async file => {
			reads?.push(file)

			return new Uint8Array(await readFile(new URL(file, ASSETS)))
		}
	})
}

const WORDS = "Characteristically international organizations hyphenate extraordinarily communicative documentation"
const SECTION = '<w:sectPr><w:pgSz w:w="4320" w:h="15840"/><w:pgMar w:top="1440" w:right="720" w:bottom="1440" w:left="720"/></w:sectPr>'

function paragraph(lang: string, pPr = ""): string {
	return `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:rPr><w:lang w:val="${lang}"/></w:rPr><w:t>${WORDS}</w:t></w:r></w:p>`
}

async function hyphenatedLines(body: string, settings: string, hyphenation = library()): Promise<string[]> {
	const layout = await layOut(buildDocx({ body: body + SECTION, settings }), { hyphenation })

	return pageLines(layout, 0)
		.filter(line => (line.flags & LineFlag.HYPHENATED) !== 0)
		.map(line => line.text)
}

describe("automatic hyphenation in Word documents", () => {
	it("hyphenates with w:autoHyphenation, loading the language's patterns on first use", async () => {
		const reads: string[] = []
		const lines = await hyphenatedLines(paragraph("en-US"), "<w:autoHyphenation/>", library(reads))

		expect(lines.length).toBeGreaterThan(0)
		expect(reads).toEqual(["hyph-en-us.txt.gz"])
	})

	it("does not hyphenate without w:autoHyphenation, nor load patterns", async () => {
		const reads: string[] = []

		expect(await hyphenatedLines(paragraph("en-US"), "", library(reads))).toEqual([])
		expect(reads).toEqual([])
	})

	it("leaves paragraphs with w:suppressAutoHyphens and text in languages without patterns whole", async () => {
		expect(await hyphenatedLines(paragraph("en-US", "<w:suppressAutoHyphens/>"), "<w:autoHyphenation/>")).toEqual([])
		expect(await hyphenatedLines(paragraph("x-none"), "<w:autoHyphenation/>")).toEqual([])
	})

	it("hyphenates fewer words with a wider hyphenation zone", async () => {
		const narrow = await hyphenatedLines(paragraph("en-US"), '<w:autoHyphenation/><w:hyphenationZone w:val="1"/>')
		const wide = await hyphenatedLines(paragraph("en-US"), '<w:autoHyphenation/><w:hyphenationZone w:val="2880"/>')

		expect(narrow.length).toBeGreaterThan(wide.length)
	})

	it("ends no two consecutive lines in a hyphen with w:consecutiveHyphenLimit 1", async () => {
		const layout = await layOut(
			buildDocx({
				body: paragraph("en-US") + SECTION,
				settings: '<w:autoHyphenation/><w:consecutiveHyphenLimit w:val="1"/><w:hyphenationZone w:val="1"/>'
			}),
			{ hyphenation: library() }
		)
		const flags = pageLines(layout, 0).map(line => (line.flags & LineFlag.HYPHENATED) !== 0)

		expect(flags.some(Boolean)).toBe(true)

		for (let k = 1; k < flags.length; k++) expect(flags[k - 1] === true && flags[k] === true).toBe(false)
	})
})
