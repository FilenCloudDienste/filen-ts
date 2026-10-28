import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { SlideNode } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"

// One ODP page given an effect on a text frame and an inserted chart, in either order, saves in one go: the ids the
// save gives the animated frame and its paragraphs and the chart object's frame never edit the same markup twice.

const PAGE =
	'<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>A</text:p><text:p>B</text:p></draw:text-box></draw:frame></draw:page>'

describe("an animated text frame and an inserted chart on one ODP page", () => {
	for (const order of ["effect first", "chart first"] as const)
		for (const byParagraph of [true, false])
			it(`saves (${order}${byParagraph ? ", by paragraph" : ""})`, async () => {
				const d = await driveSession(odpBytes({ body: PAGE }), "odp")
				const deck = d.session.deck
				const slide = await odpParts(deck)?.slide(deck.slides[0] ?? (0 as never))
				const preset = effectPreset("entr", 2)

				if (slide === undefined || preset === undefined) throw new Error("fixture")

				const node = (): SlideNode => deck.nodes.get(slide.ref) ?? slide
				const animate = async (): Promise<void> => {
					const id = node().shapes.find(shape => shape.name === "T")?.id ?? -1
					const rows = slideEffects(node().timing)
					const op = addEffectsOp(slide.ref, rows.kind === "effects" ? rows.rows : [], [{ id, paragraphs: 2 }], {
						preset,
						byParagraph,
						aspect: 4 / 3
					})

					if (op === undefined) throw new Error("no op")

					expect(await d.command(op)).toMatchObject({ ok: true })
				}
				const chart = async (): Promise<void> => {
					const op = insertChartOp(deck, slide.ref, 0, "column", sampleChartCells({ categories: ["A", "B"], series: ["S"] }))

					expect(await d.command(op)).toMatchObject({ ok: true })
				}

				if (order === "effect first") {
					await animate()
					await chart()
				} else {
					await chart()
					await animate()
				}

				const saved = await d.save()

				expect(saved.result.kind).toBe("written")

				const content = text((await entriesOf(saved.bytes ?? new Uint8Array())).get("content.xml"))
				const ids = new Set([...content.matchAll(/xml:id="([^"]*)"/gu)].map(match => match[1]))
				const targets = [...content.matchAll(/smil:targetElement="([^"]*)"/gu)].map(match => match[1])

				expect(content).toContain("<draw:object")
				expect(targets.length).toBeGreaterThan(0)
				expect(targets.filter(target => !ids.has(target))).toEqual([])
			})
})
