import { describe, expect, it } from "vitest"
import type { TimeNode } from "../core/anim/model"
import { freshOdp } from "../core/odp/write/fresh"
import { slideRef, type ShapeNode } from "../core/presentation/model"
import { TimingBuilder } from "./animFixtures"
import { FIXTURE_FIRST_SLIDE, fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"

// xml:id is unique in the whole document (ODF 1.3 Part 1 §19.914) while PresentationML shape and time node ids are
// unique only on their slide: a converted deck names every page's targets and time nodes apart, and its references
// follow them.

function box(): ShapeNode {
	return {
		id: 50,
		name: "Box",
		hidden: false,
		kind: "sp",
		xfrm: { x: 914_400, y: 914_400, cx: 1_000_000, cy: 1_000_000, rot: 0, flipH: false, flipV: false },
		props: { geometry: { kind: "preset", preset: "rect", guides: [] } },
		text: fixtureBody(["Box"])
	}
}

// A click on the box fades it out, and an after-effect (named by its master's id) hides it on the next click.
function timing() {
	const b = new TimingBuilder()
	const fade: TimeNode = b.fadeOut(50, "clickEffect")
	const hide = b.set(50, "style.visibility", "hidden", { masterRel: "nextClick", stCondLst: [{ delay: 0 }] })

	fade.ctn.subTnLst = [hide]

	return b.root([b.mainSeq([b.click([[0, [fade]]])]), b.interactive(50, [b.fadeOut(50, "clickEffect")])])
}

// The page's text:p ids and the IDREFs its timing makes.
function idsAndRefs(content: string): { readonly ids: string[]; readonly refs: string[] } {
	return {
		ids: [...content.matchAll(/ xml:id="([^"]+)"/gu)].map(match => match[1] ?? ""),
		refs: [...content.matchAll(/ (?:smil:targetElement|presentation:master-element)="([^"]+)"/gu)].map(match => match[1] ?? "")
	}
}

describe("fresh ODP ids", () => {
	it("gives the paragraphs a by-paragraph effect targets the ids its timing names them by, apart on each page", async () => {
		const deck = fixtureDeck(2)

		for (const index of [0, 1]) {
			const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE + index))

			if (slide === undefined) throw new Error("fixture slide missing")

			const b = new TimingBuilder()
			const appear = b.behavior(
				{
					type: "set",
					common: { target: { kind: "text", shape: 50, unit: "para", start: 0, end: 0 }, attrNames: ["style.visibility"] },
					to: "visible"
				},
				{ dur: 1 }
			)

			slide.shapes.push(box())
			slide.timing = b.root([
				b.mainSeq([
					b.click([
						[0, [b.effect(50, { presetID: 1, presetClass: "entr", presetSubtype: 0, nodeType: "clickEffect" }, 0, [appear])]]
					])
				])
			])
		}

		const fresh = await freshOdp(deck, { theme: () => undefined, picture: () => Promise.resolve(undefined) })

		if ("kind" in fresh) throw new Error(`refused ${fresh.reason}`)

		const change = fresh.parts.find(entry => entry.name === "content.xml")
		const { ids, refs } = idsAndRefs(change === undefined ? "" : new TextDecoder().decode(change.bytes as Uint8Array))

		expect(refs.length).toBeGreaterThanOrEqual(2)
		expect(new Set(ids).size).toBe(ids.length)

		for (const ref of refs) expect(ids, ref).toContain(ref)
	})

	it("names the same shape and time node ids on two pages apart, with every reference following", async () => {
		const deck = fixtureDeck(2)

		for (const index of [0, 1]) {
			const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE + index))

			if (slide === undefined) throw new Error("fixture slide missing")

			slide.shapes.push(box())
			slide.timing = timing()
		}

		const fresh = await freshOdp(deck, { theme: () => undefined, picture: () => Promise.resolve(undefined) })

		if ("kind" in fresh) throw new Error(`refused ${fresh.reason}`)

		const change = fresh.parts.find(entry => entry.name === "content.xml")
		const content = change === undefined ? "" : new TextDecoder().decode(change.bytes as Uint8Array)
		const ids = [...content.matchAll(/ xml:id="([^"]+)"/gu)].map(match => match[1] ?? "")

		expect(ids.length).toBeGreaterThan(2)
		expect(new Set(ids).size).toBe(ids.length)

		// Every IDREF names an id the document has.
		const defined = new Set(ids)
		const refs = [...content.matchAll(/ (?:smil:targetElement|presentation:master-element)="([^"]+)"/gu)].map(match => match[1] ?? "")
		const begins = [...content.matchAll(/ smil:(?:begin|end)="([^"]+)"/gu)].flatMap(match =>
			(match[1] ?? "").split(";").flatMap(token => {
				const name = /^([A-Za-z_][\w.-]*?)\.(?:begin|end|click)\b/u.exec(token.trim())?.[1]

				return name === undefined ? [] : [name]
			})
		)

		expect(refs.length).toBeGreaterThan(0)

		for (const ref of [...refs, ...begins]) expect(defined.has(ref), ref).toBe(true)
	})
})
