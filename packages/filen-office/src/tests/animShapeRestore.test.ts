import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { authoringDeck } from "./animAuthoringFixtures"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"

// A shape deleted with its effects and put back by an undo is written as the file had it, effects included, before a
// save and after one (its held markup goes back into the page without the declarations it carried to be read alone).

const PAGE =
	'<draw:page draw:name="a" draw:master-page-name="M">' +
	'<draw:frame draw:name="Body" presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="9cm"><draw:text-box><text:list><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list></draw:text-box></draw:frame>' +
	'<draw:custom-shape draw:name="Box" svg:x="18cm" svg:y="15cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>' +
	"</draw:page>"

function preset(presetClass: string, id: number) {
	const found = effectPreset(presetClass, id)

	if (found === undefined) throw new Error("no preset")

	return found
}

function defined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing")

	return value
}

for (const format of ["pptx", "odp"] as const)
	for (const saveBetween of [false, true])
		describe(`deleting an animated shape and undoing it (${format}, a save between: ${String(saveBetween)})`, () => {
			it("puts the shape and its effects back as the file had them", async () => {
				const bytes = format === "pptx" ? authoringDeck() : odpBytes({ body: PAGE })
				const part = format === "pptx" ? "ppt/slides/slide1.xml" : "content.xml"
				const h = await driveSession(bytes, format)
				const slide = async (): Promise<SlideNode> => {
					const deck = h.session.deck
					const parts = format === "pptx" ? pptxParts(deck) : odpParts(deck)

					return (await defined(parts).slide(defined(deck.slides[0]))) as SlideNode
				}
				const partOf = async (saved: Uint8Array | undefined): Promise<string> => text((await entriesOf(defined(saved))).get(part))
				const command = async (op: DeckOp | undefined): Promise<void> => {
					expect(await h.command(defined(op))).toMatchObject({ ok: true })
				}
				const first = await slide()
				const body = format === "pptx" ? 3 : defined(first.shapes.find(shape => shape.name === "Body")).id
				const box = format === "pptx" ? 4 : defined(first.shapes.find(shape => shape.name === "Box")).id

				await command(
					addEffectsOp(first.ref, [], [{ id: body, paragraphs: 2 }], {
						preset: preset("entr", 10),
						aspect: 4 / 3,
						byParagraph: true
					})
				)

				const rows = slideEffects((await slide()).timing)

				await command(
					addEffectsOp(
						first.ref,
						rows.kind === "effects" ? rows.rows : [],
						[{ id: box }],
						{ preset: preset("emph", 8), aspect: 4 / 3 },
						"with"
					)
				)

				const want = await partOf((await h.save()).bytes)

				await command({ family: "shape", kind: "delete", slide: first.ref, shapes: [body] })

				if (saveBetween) {
					const mid = await h.save()

					expect(mid.result.kind).toBe("written")
					expect(await partOf(mid.bytes)).not.toMatch(format === "pptx" ? /spid="3"/u : /ooo-entrance-fade-in/u)
				}

				expect(await h.undo()).toMatchObject({ ok: true })

				const after = await h.save()

				expect(after.bytes === undefined ? want : await partOf(after.bytes)).toBe(want)
			})
		})
