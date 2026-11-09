import { describe, expect, it } from "vitest"
import { freshOdp } from "../core/odp/write/fresh"
import { slideRef, type ShapeNode } from "../core/presentation/model"
import { FIXTURE_FIRST_SLIDE, fixtureDeck } from "./fixtures/presentation/deck"

// DrawingML date and time fields (ECMA-376 §21.1.2.2.4, ST_TextField) as ODF fields: datetime10 to datetime13 are
// time formats, written as text:time (ODF 1.3 Part 3 §7.3.3); the rest, date plus time included, as text:date.

function fieldBox(types: readonly string[]): ShapeNode {
	return {
		id: 50,
		name: "TextBox 49",
		hidden: false,
		kind: "sp",
		txBox: true,
		xfrm: { x: 914_400, y: 914_400, cx: 3_000_000, cy: 1_000_000, rot: 0, flipH: false, flipV: false },
		props: { geometry: { kind: "preset", preset: "rect", guides: [] } },
		text: {
			bodyPr: {},
			paragraphs: types.map(type => ({ pPr: {}, runs: [{ kind: "fld" as const, id: `{${type}}`, type, text: type, rPr: {} }] }))
		}
	}
}

async function content(types: readonly string[]): Promise<string> {
	const deck = fixtureDeck(1)
	const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE))

	if (slide === undefined) throw new Error("fixture slide missing")

	slide.shapes.push(fieldBox(types))

	const fresh = await freshOdp(deck, { theme: () => undefined, picture: () => Promise.resolve(undefined) })

	if ("kind" in fresh) throw new Error(`refused ${fresh.reason}`)

	const part = fresh.parts.find(entry => entry.name === "content.xml")

	return part === undefined ? "" : new TextDecoder().decode(part.bytes as Uint8Array)
}

describe("ODP date and time fields", () => {
	it("writes the time formats as text:time and the date formats as text:date", async () => {
		const times = ["datetime10", "datetime11", "datetime12", "datetime13"]
		const dates = ["datetime", "datetime1", "datetime8", "datetime9"]
		const xml = await content([...dates, ...times])

		for (const type of times) expect(xml).toContain(`<text:time>${type}</text:time>`)
		for (const type of dates) expect(xml).toContain(`<text:date>${type}</text:date>`)
	})
})
