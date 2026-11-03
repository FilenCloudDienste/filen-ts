import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Deck, ShapeNode } from "../core/presentation/model"
import { CORPUS_DIR } from "./corpusDir"
import { openOdpDeck } from "./odpWriteFixtures"
import { driveSession } from "./odpWriteDrive"
import { budget, cpuMs } from "./timing"

// A gallery theme on a corpus ODP our save cannot prove: lo__tdf96708's frames name automatic styles (pr1–pr4, P1,
// P2) its content.xml never declares (it has no office:automatic-styles), so they take their master page's
// presentation styles by class, and reading the written file back gives them the new master's instead of the ones the
// session shows. The save is refused as proofFailed (the page tells the user the changes were undone), never
// written half-right, and the deck keeps its pages.

const FILE = join(CORPUS_DIR, "odp", "lo__tdf96708.odp")

describe.skipIf(!existsSync(FILE))("a gallery theme on an ODP whose objects name no style", () => {
	it("refuses the save as proofFailed and leaves the session open with its edits", async () => {
		const d = await driveSession(new Uint8Array(readFileSync(FILE)))
		const applied = await d.command({ family: "design", kind: "setTheme", theme: { kind: "gallery", id: "slate", variant: 0 } })

		expect(applied.ok).toBe(true)

		const saved = await d.save()

		expect(saved.result).toMatchObject({ kind: "refused", reason: "proofFailed" })
		expect(saved.bytes).toBeUndefined()
		expect(d.session.deck.slides.length).toBeGreaterThan(0)
	})
})

// A slide size change in each scale mode over every ODP deck of the corpus: the change is refused when it is sent, with
// a typed reason, or the save writes it, and the saved file reopens at the new size with every shape box it had.
// FILEN_OFFICE_ODP_SIZE_OUT: a directory the saved decks (and each save's CPU time) are written to, for jing (ODF 1.3
// RELAX NG) and the ODF validator outside the suite.

const DIRECTORY = join(CORPUS_DIR, "odp")
const OUT = process.env["FILEN_OFFICE_ODP_SIZE_OUT"] || undefined
const FILES = existsSync(DIRECTORY)
	? readdirSync(DIRECTORY)
			.filter(name => name.endsWith(".odp"))
			.sort()
	: []
const MODES = ["none", "ensureFit", "maximize"] as const

// The changes refused when sent, by deck and mode:
//   - lo__tdf163343 has no styles.xml, where ODF keeps the page size (ODF 1.3 Part 2 §3.1): every mode is refused.
//   - The others hold shapes the open-time proof locked (each would read back differently when written), which a change
//     that moves the content cannot move: routed connectors (lo__tdf151492, lo__tdf66228, odftk__Presentation2__2) and
//     turned, mirrored shapes (lo__rotate_flip). Don't scale moves nothing and saves.
// govuk__Shaping_the_Qualifications_Landscape's locked groups of pictures follow: their boxes are written by attributes,
// their text by scaled copies of its automatic styles.
const REFUSED: Readonly<Record<string, string>> = {
	"lo__rotate_flip.odp ensureFit": "locked",
	"lo__rotate_flip.odp maximize": "locked",
	"lo__tdf151492.odp ensureFit": "locked",
	"lo__tdf151492.odp maximize": "locked",
	"lo__tdf163343.odp none": "unsupported",
	"lo__tdf163343.odp ensureFit": "unsupported",
	"lo__tdf163343.odp maximize": "unsupported",
	"lo__tdf66228.odp ensureFit": "locked",
	"lo__tdf66228.odp maximize": "locked",
	"odftk__Presentation2__2.odp ensureFit": "locked",
	"odftk__Presentation2__2.odp maximize": "locked"
}

function boxes(deck: Deck): number {
	let count = 0
	const walk = (shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			if (shape.xfrm !== undefined) count++
			if (shape.children !== undefined) walk(shape.children)
		}
	}

	for (const ref of [...deck.masters, ...deck.slides]) walk(deck.nodes.get(ref)?.shapes ?? [])

	return count
}

describe.skipIf(FILES.length === 0)("a slide size change on every ODP deck of the corpus", () => {
	it(
		"is refused when sent with a typed reason, or saves and reopens at the new size with every box",
		{ timeout: budget(900_000) },
		async () => {
			if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

			const refusals: Record<string, string> = {}
			const saves: Record<string, number> = {}

			for (const name of FILES) {
				const bytes = new Uint8Array(readFileSync(join(DIRECTORY, name)))
				const source = boxes((await openOdpDeck(bytes)).deck)

				for (const scale of MODES) {
					const key = `${name} ${scale}`
					const d = await driveSession(bytes)
					const op: DeckOp = { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, type: "screen4x3", scale }
					const applied = await d.command(op)

					if (!applied.ok) {
						refusals[key] = applied.refusal
						continue
					}

					const start = cpuMs()
					const saved = await d.save()

					saves[key] = cpuMs() - start

					expect(saved.result.kind, key).toBe("written")

					const written = saved.bytes as Uint8Array
					const back = await openOdpDeck(written)

					expect(back.deck.size, key).toMatchObject({ cx: 9_144_000, cy: 6_858_000 })
					expect(boxes(back.deck), key).toBe(source)

					if (OUT !== undefined) writeFileSync(join(OUT, `${name.slice(0, -4)}.${scale}.odp`), written)
				}
			}

			expect(refusals).toEqual(REFUSED)

			if (OUT !== undefined) writeFileSync(join(OUT, "saves-cpu-ms.json"), JSON.stringify(saves, null, "\t"))
		}
	)
})
