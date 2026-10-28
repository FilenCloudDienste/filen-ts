import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CORPUS_DIR } from "./corpusDir"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { entriesOf, openOdpDeck, text } from "./odpWriteFixtures"
import { plainText } from "./odpFixtures"
import { budget } from "./timing"

// The fresh ODP writer from pptx decks (a conversion): every unencrypted pptx deck of the corpus converts into a
// package that opens with the same slide count, mimetype first and stored, every placed text kept; what ODF cannot
// hold is named in the report. FILEN_OFFICE_ODP_FRESH_OUT: a directory the packages are written to, for jing, the ODF
// validator and LibreOffice's UNO parity outside the suite.

const DIRECTORY = join(CORPUS_DIR, "pptx")
const OUT = process.env["FILEN_OFFICE_ODP_FRESH_OUT"] || undefined
const FILES = existsSync(DIRECTORY)
	? readdirSync(DIRECTORY)
			.filter(name => name.endsWith(".pptx"))
			.sort()
	: []
const SHAPING = "govuk__Shaping_the_Qualifications_Landscape.pptx"

describe.skipIf(FILES.length === 0)("fresh ODP writer", () => {
	it("converts govuk Shaping with its pages, master pages, pictures and text", { timeout: budget(120_000) }, async () => {
		const fresh = await freshFromPptx(new Uint8Array(readFileSync(join(DIRECTORY, SHAPING))))

		if ("kind" in fresh) throw new Error(fresh.reason)

		const entries = await entriesOf(fresh.bytes)
		const content = text(entries.get("content.xml"))
		const opened = await openOdpDeck(fresh.bytes)
		const texts = opened.deck.slides.flatMap(ref => opened.deck.nodes.get(ref)?.shapes.map(shape => plainText(shape)) ?? [])

		expect([...entries.keys()][0]).toBe("mimetype")
		expect(opened.deck.slides).toHaveLength(81)
		expect(content).toContain('office:version="1.3"')
		expect([...entries.keys()].filter(name => name.startsWith("Pictures/")).length).toBeGreaterThan(10)
		expect(texts.join(" ")).toContain("qualifications")
		// Its two charts hold no series (nothing an object could show); its diagrams are written as groups of their shapes.
		expect(fresh.report.omitted).toMatchObject({ "chart frame": 2 })
		expect(fresh.report.omitted["smartart frame"]).toBeUndefined()
		// Tables are written by the table family.
		expect(fresh.report.omitted["table frame"]).toBeUndefined()
		expect(content).toContain("<table:table")
	})

	it("writes a SmartArt diagram from its cached drawing as a group with every node's text", { timeout: budget(120_000) }, async () => {
		const fresh = await freshFromPptx(new Uint8Array(readFileSync(join(DIRECTORY, "poi__customGeo.pptx"))))

		if ("kind" in fresh) throw new Error(fresh.reason)

		const content = text((await entriesOf(fresh.bytes)).get("content.xml"))

		expect(fresh.report.omitted["smartart frame"]).toBeUndefined()
		// A node of the deck's first diagram (ppt/diagrams/drawing1.xml), its text box's offset as the shape's insets.
		expect(content).toMatch(/<draw:g\b[^>]*>(?:(?!<\/draw:g>)[\s\S])*Ohio’s New Learning Standards for English Language Arts/u)
	})

	it("converts every unencrypted pptx deck into a package that opens with its slide count", { timeout: budget(900_000) }, async () => {
		if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

		for (const name of FILES) {
			const fresh = await freshFromPptx(new Uint8Array(readFileSync(join(DIRECTORY, name))))

			if ("kind" in fresh) {
				expect(fresh.reason, name).toBe("encrypted")

				continue
			}

			if (OUT !== undefined) writeFileSync(join(OUT, name.replace(/\.pptx$/u, ".odp")), fresh.bytes)
		}
	})
})
