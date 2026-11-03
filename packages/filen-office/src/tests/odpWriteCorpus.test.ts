import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CORPUS_DIR } from "./corpusDir"
import { applyOdpShapeAndSlideEdits, applyOdpTextEdits, changes, openOdpDeck, saveDeck } from "./odpWriteFixtures"
import { budget } from "./timing"

// The ODP writer over every ODP deck of the corpus:
//   - untouched identity: a deck opened and saved, or with slides touched and nothing changed, is unchanged;
//   - the shape and slide edit set (move, resize, turn and fill a shape; hide, re-lay, duplicate, add, delete and move slides) and the
//     text edits (type, bold a range, centre, add a paragraph) save, pass gate 2, read back with the deck's slide
//     count, and the saved file saves again as unchanged; the same edits write the same bytes twice.
// FILEN_OFFICE_ODP_WRITE_OUT: a directory the edited decks are written to, for jing (ODF 1.3 RELAX NG), the ODF
// validator and LibreOffice outside the suite.

const DIRECTORY = join(CORPUS_DIR, "odp")
const OUT = process.env["FILEN_OFFICE_ODP_WRITE_OUT"] || undefined
const FILES = existsSync(DIRECTORY)
	? readdirSync(DIRECTORY)
			.filter(name => name.endsWith(".odp"))
			.sort()
	: []

describe.skipIf(FILES.length === 0)("ODP writer corpus", () => {
	it("saves every deck opened without edits as unchanged", { timeout: budget(300_000) }, async () => {
		for (const name of FILES) {
			const opened = await openOdpDeck(new Uint8Array(readFileSync(join(DIRECTORY, name))))

			for (const node of opened.deck.nodes.values()) node.revision++

			expect((await saveDeck(opened)).outcome.kind, name).toBe("unchanged")
		}
	})

	it("saves the edit sets on every deck, read back by gate 2 and again by a reopen", { timeout: budget(600_000) }, async () => {
		if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

		for (const name of FILES) {
			const bytes = new Uint8Array(readFileSync(join(DIRECTORY, name)))
			const edited: Uint8Array[] = []
			let slides = 0

			for (let run = 0; run < 2; run++) {
				const opened = await openOdpDeck(bytes)

				applyOdpTextEdits(opened)

				const report = applyOdpShapeAndSlideEdits(opened)

				expect(report.refusals, name).toEqual([])

				slides = opened.deck.slides.length

				const saved = await saveDeck(opened, changes("slideList", "customShows"))

				expect(
					saved.outcome.kind === "refused" ? `${saved.outcome.reason} ${saved.outcome.detail ?? ""}` : saved.outcome.kind,
					name
				).toBe("written")
				edited.push(saved.bytes)
			}

			expect(edited[1], `${name} saves the same bytes twice`).toEqual(edited[0])

			const reopened = await openOdpDeck(edited[0] as Uint8Array)

			expect(reopened.deck.slides, name).toHaveLength(slides)
			expect((await saveDeck(reopened)).outcome.kind, name).toBe("unchanged")

			if (OUT !== undefined) writeFileSync(join(OUT, name), edited[0] as Uint8Array)
		}
	})
})
