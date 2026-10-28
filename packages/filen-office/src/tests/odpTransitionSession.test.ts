import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { presetTransition, TRANSITION_PRESETS } from "../core/anim/presets/transitions/catalog"
import { addEffectsOp, effectTimingOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { SlideNode } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"

// A transition authored in an ODP session is the file's own once saved: later saves that rewrite the page keep its
// drawing-page style and its transition par, and an undo after a save writes what the save before it wrote.

const PAGE = (name: string): string =>
	`<draw:page draw:name="${name}" draw:master-page-name="M">` +
	'<draw:custom-shape draw:name="Box" svg:x="18cm" svg:y="15cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>' +
	"</draw:page>"

describe("an authored ODP transition across saves in a session", () => {
	it("keeps its page style and par while the page's timing changes and is undone", async () => {
		const h = await driveSession(odpBytes({ body: PAGE("a") + PAGE("b") }), "odp")
		const slide = async (): Promise<SlideNode> => {
			const deck = h.session.deck
			const node = await odpParts(deck)?.slide(deck.slides[0] ?? (0 as never))

			if (node === undefined) throw new Error("no slide")

			return node as SlideNode
		}
		const content = async (bytes: Uint8Array | undefined): Promise<string> => {
			if (bytes === undefined) throw new Error("not written")

			return text((await entriesOf(bytes)).get("content.xml"))
		}
		const first = await slide()
		const box = first.shapes.find(shape => shape.name === "Box")?.id ?? -1
		const vortex = TRANSITION_PRESETS.find(entry => entry.kind === "vortex")
		const fade = effectPreset("entr", 10)

		if (vortex === undefined || fade === undefined) throw new Error("no preset")

		expect(
			await h.command({ family: "transition", kind: "set", slides: [first.ref], transition: presetTransition(vortex) })
		).toMatchObject({
			ok: true
		})

		const add = addEffectsOp(first.ref, [], [{ id: box }], { preset: fade, aspect: 4 / 3 })

		if (add === undefined) throw new Error("no op")

		expect(await h.command(add)).toMatchObject({ ok: true })

		const a = await content((await h.save()).bytes)
		const style = (xml: string): string | undefined =>
			/<style:style style:name="dp\d+" style:family="drawing-page">.*?<\/style:style>/su.exec(xml)?.[0]

		expect(style(a)).toBeDefined()

		const rows = slideEffects((await slide()).timing)
		const retime = effectTimingOp((await slide()).ref, [rows.kind === "effects" ? (rows.rows[0]?.id ?? 0) : 0], { durationMs: 1500 })

		if (retime === undefined) throw new Error("no op")

		expect(await h.command(retime)).toMatchObject({ ok: true })

		const b = await content((await h.save()).bytes)

		expect(style(b)).toBe(style(a))

		expect(await h.undo()).toMatchObject({ ok: true })
		expect(await content((await h.save()).bytes)).toBe(a)
		expect(await h.redo()).toMatchObject({ ok: true })
		expect(await content((await h.save()).bytes)).toBe(b)
	})
	it("writes the page as the file had it once an authored transition is undone after a save", async () => {
		const source = odpBytes({ body: PAGE("a") + PAGE("b") })
		const h = await driveSession(source, "odp")
		const deck = h.session.deck
		const first = await odpParts(deck)?.slide(deck.slides[0] ?? (0 as never))
		const vortex = TRANSITION_PRESETS.find(entry => entry.kind === "vortex")

		if (first === undefined || vortex === undefined) throw new Error("fixture")

		const page = async (bytes: Uint8Array | undefined): Promise<string | undefined> => {
			if (bytes === undefined) throw new Error("not written")

			return /<draw:page draw:name="a".*?<\/draw:page>/su.exec(text((await entriesOf(bytes)).get("content.xml")))?.[0]
		}

		expect(
			await h.command({ family: "transition", kind: "set", slides: [first.ref], transition: presetTransition(vortex) })
		).toMatchObject({
			ok: true
		})
		expect(await page((await h.save()).bytes)).toContain("draw:style-name")
		expect(await h.undo()).toMatchObject({ ok: true })

		const saved = await h.save()

		expect(await page(saved.bytes ?? source)).toBe(await page(source))
	})
})
