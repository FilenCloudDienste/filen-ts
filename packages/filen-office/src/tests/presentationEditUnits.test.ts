import { describe, expect, it } from "vitest"
import type { DeckChanges, Dirt, PartChanges } from "../core/presentation/edit/apply"
import {
	ContentScaler,
	rescaleMarkup,
	type ScaledValues,
	scaledValues,
	statedValues,
	statesWithin
} from "../core/presentation/edit/apply/designScale"
import { matchShapes } from "../core/presentation/edit/apply/match"
import {
	slideRef,
	type Deck,
	type ListStyle,
	type ShapeKind,
	type ShapeNode,
	type SlideNode,
	type SourceRef,
	type TextBody
} from "../core/presentation/model"
import { mediaDropped } from "../core/presentation/restoredMedia"

// Direct tests of the pure decisions the edit and save paths depend on.

const PART = "/ppt/slides/slide1.xml"

const PPTX: SourceRef = { format: "pptx", part: PART, node: 0, epoch: 0 }
const ODP: SourceRef = { format: "odp", part: "content.xml", fragment: 0, node: 0, epoch: 0 }

function shape(id: number, name: string, extra: Partial<ShapeNode> = {}, kind: ShapeKind = "sp"): ShapeNode {
	return { id, name, kind, hidden: false, ...extra }
}

describe("matchShapes", () => {
	it("binds by place when both lists are the same shapes in the same order", () => {
		const typed = [shape(1, "Title"), shape(2, "Body")]
		const read = [shape(7, "Title", { src: ODP }), shape(8, "Body", { src: ODP })]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBe(read[0])
		expect(matched[1]).toBe(read[1])
	})

	it("binds a reordered pptx slide by id, a renamed shape included", () => {
		const typed = [shape(2, "Body"), shape(1, "Renamed")]
		const read = [shape(1, "Title", { src: PPTX }), shape(2, "Body", { src: PPTX })]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBe(read[1])
		expect(matched[1]).toBe(read[0])
	})

	it("binds by the written id when the reader reassigned a duplicate", () => {
		const typed = [shape(9, "B", { sourceId: 4 }), shape(1, "A")]
		const read = [shape(1, "A", { src: PPTX }), shape(5, "B", { sourceId: 4, src: PPTX })]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBe(read[1])
		expect(matched[1]).toBe(read[0])
	})

	it("does not trust a pptx id naming a shape of another kind", () => {
		const typed = [shape(3, "Picture", {}, "pic"), shape(1, "Title")]
		const read = [shape(1, "Title", { src: PPTX }), shape(3, "Other", { src: PPTX })]

		expect(matchShapes(typed, read)).toEqual([undefined, read[0]])
	})

	it("binds ODP shapes renumbered by place after a removal by kind and name, never by the shifted id", () => {
		// The page had shapes 1 (A), 2 (B), 3 (C); a save took A out and an edit added D. The re-read numbers the shapes
		// by their place: B is 1, C is 2, D is 3, so the typed B's id 2 now names C and C's id 3 names D.
		const typed = [shape(2, "B"), shape(3, "C")]
		const read = [shape(1, "B", { src: ODP }), shape(2, "C", { src: ODP }), shape(3, "D", { src: ODP })]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBe(read[0])
		expect(matched[1]).toBe(read[1])
	})

	it("binds swapped ODP shapes renumbered by place by kind and name", () => {
		const typed = [shape(3, "C"), shape(2, "B")]
		const read = [shape(1, "B", { src: ODP }), shape(2, "C", { src: ODP })]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBe(read[1])
		expect(matched[1]).toBe(read[0])
	})

	it("leaves an ODP shape unmatched when its shifted id names another shape and its name is not unique", () => {
		const typed = [shape(2, "Box"), shape(1, "Title")]
		const read = [
			shape(1, "Title", { src: ODP }),
			shape(2, "Other", { src: ODP }),
			shape(3, "Box", { src: ODP }),
			shape(4, "Box", { src: ODP })
		]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBeUndefined()
		expect(matched[1]).toBe(read[0])
	})

	it("gives no match by a name two shapes share, nor by an empty name", () => {
		const typed = [shape(9, "Box"), shape(8, "")]
		const read = [shape(1, "Box", { src: PPTX }), shape(2, "Box", { src: PPTX }), shape(3, "", { src: PPTX })]

		expect(matchShapes(typed, read)).toEqual([undefined, undefined])
	})

	it("uses each read shape once", () => {
		// The second typed shape has no id match; its name is unique among the read shapes but the first took that shape.
		const typed = [shape(1, "Title"), shape(7, "Title")]
		const read = [shape(1, "Title", { src: PPTX }), shape(2, "Body", { src: PPTX })]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBe(read[0])
		expect(matched[1]).toBeUndefined()
	})

	it("uses each read shape once when two typed shapes give the same id", () => {
		const typed = [shape(4, "Box", { sourceId: 4 }), shape(6, "Box", { sourceId: 4 })]
		const read = [shape(4, "Box", { src: PPTX })]
		const matched = matchShapes(typed, read)

		expect(matched[0]).toBe(read[0])
		expect(matched[1]).toBeUndefined()
	})
})

describe("mediaDropped", () => {
	function deckOf(shapes: ShapeNode[]): Deck {
		const ref = slideRef(1)
		const node = { ref, kind: "slide", part: PART, shapes, showMasterShapes: true, hidden: false } as unknown as SlideNode

		return { nodes: new Map([[ref, node]]) } as unknown as Deck
	}

	function changesOf(part: string, change: PartChanges["change"], shapes: [number, Dirt][], slide?: Dirt): DeckChanges {
		const changes: PartChanges = slide === undefined ? { change, shapes: new Map(shapes) } : { change, shapes: new Map(shapes), slide }

		return { empty: false, parts: new Map([[part, changes]]), presentation: new Set() }
	}

	const deck = deckOf([shape(1, "Picture", {}, "pic"), shape(2, "Group", { children: [shape(3, "Member")] }, "grpSp")])

	it("is false for no changes", () => {
		expect(mediaDropped(deck, { empty: true, parts: new Map(), presentation: new Set() })).toBe(false)
	})

	it("is false for text, box and other property changes of shapes still there", () => {
		expect(mediaDropped(deck, changesOf(PART, "changed", [[1, { kind: "text" }]]))).toBe(false)
		expect(mediaDropped(deck, changesOf(PART, "changed", [[1, { kind: "xfrm" }]]))).toBe(false)
		expect(mediaDropped(deck, changesOf(PART, "changed", [[3, { kind: "props", group: "ln" }]]))).toBe(false)
		expect(mediaDropped(deck, changesOf(PART, "changed", [], { kind: "slidePart", part: "timing" }))).toBe(false)
	})

	it("is true for a fill change", () => {
		expect(mediaDropped(deck, changesOf(PART, "changed", [[1, { kind: "props", group: "fill" }]]))).toBe(true)
	})

	it("is true for a replaced background", () => {
		expect(mediaDropped(deck, changesOf(PART, "changed", [], { kind: "slidePart", part: "background" }))).toBe(true)
	})

	it("is true for a removed part", () => {
		expect(mediaDropped(deck, changesOf(PART, "removed", []))).toBe(true)
	})

	it("is true for a changed shape no longer there, or a part with no node", () => {
		expect(mediaDropped(deck, changesOf(PART, "changed", [[99, { kind: "node" }]]))).toBe(true)
		expect(mediaDropped(deck, changesOf("/ppt/slides/slide2.xml", "changed", [[1, { kind: "text" }]]))).toBe(true)
	})
})

describe("designScale", () => {
	type Paragraph = TextBody["paragraphs"][number]

	function body(sizes: number[], end?: number, marL = 342_900, pts = 600): TextBody {
		const out: TextBody = {
			bodyPr: {},
			paragraphs: [{ pPr: { marL, spcBef: { pts } }, runs: sizes.map(sz => ({ kind: "r", text: "a", rPr: { sz } })) }]
		}

		if (end !== undefined) (out.paragraphs[0] as Paragraph).endRPr = { sz: end }

		return out
	}

	it("reads the stated values per tag and attribute", () => {
		const markup =
			'<a:pPr marL="342900" indent="-342900" algn="l"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buSzPts val="1200"/><a:buSzPct val="90000"/></a:pPr>' +
			'<a:r><a:rPr lang="en-US" sz="2000" spc="50"/><a:t>x</a:t></a:r><a:endParaRPr sz="1800"/>' +
			'<a:lstStyle><a:lvl2pPr marL="914400"><a:defRPr sz="2400"/></a:lvl2pPr></a:lstStyle><a:bodyPr lIns="91440"/>'

		expect(statedValues(markup)).toEqual(
			new Map([
				["marL", new Set([342_900, 914_400])],
				["indent", new Set([-342_900])],
				["pts", new Set([600])],
				["sz", new Set([1200, 2000, 1800, 2400])]
			])
		)
	})

	it("tells whether every stated value is stated within other markup, by kind", () => {
		const within = '<a:rPr sz="2000"/><a:spcPts val="600"/>'

		expect(statesWithin('<a:rPr sz="2000"/>', within)).toBe(true)
		expect(statesWithin('<a:rPr sz="2400"/>', within)).toBe(false)
		// 600 is stated within, but as spacing, not a size.
		expect(statesWithin('<a:rPr sz="600"/>', within)).toBe(false)
	})

	it("rescales each stated value, or answers undefined for one it has no scaled value for", () => {
		const values: ScaledValues = new Map([["sz", new Map([[2000, 1000]])]])

		expect(rescaleMarkup('<a:rPr lang="en-US" sz="2000"/><a:endParaRPr sz="2000"/>', values)).toBe(
			'<a:rPr lang="en-US" sz="1000"/><a:endParaRPr sz="1000"/>'
		)
		expect(rescaleMarkup('<a:rPr sz="2000"/><a:rPr sz="2400"/>', values)).toBeUndefined()
		expect(rescaleMarkup('<a:pPr marL="10"/>', values)).toBeUndefined()
	})

	it("maps each value a scale changed, before to after", () => {
		const before = shape(1, "Alt", { text: body([2000, 2000], 2000) })
		const after = shape(1, "Alt", { text: body([1000, 1000], 1000, 171_450, 300) })

		expect(scaledValues(before, after)).toEqual(
			new Map([
				["sz", new Map([[2000, 1000]])],
				["marL", new Map([[342_900, 171_450]])],
				["pts", new Map([[600, 300]])]
			])
		)
	})

	it("answers undefined when one value maps two ways", () => {
		const before = shape(1, "Alt", { text: body([2000, 2000]) })
		const after = shape(1, "Alt", { text: body([1000, 1500]) })

		expect(scaledValues(before, after)).toBeUndefined()
	})

	it("answers undefined when anything besides the scaled values differs", () => {
		const before = shape(1, "Alt", { text: body([2000]) })
		const changed = body([1000])
		const after = shape(1, "Alt", {
			text: {
				...changed,
				paragraphs: [{ ...(changed.paragraphs[0] as Paragraph), runs: [{ kind: "r", text: "b", rPr: { sz: 1000 } }] }]
			}
		})

		expect(scaledValues(before, after)).toBeUndefined()
	})

	it("restores the original objects after a scale", () => {
		const original = body([2000, 1800], 2400)
		const scaler = new ContentScaler(0.5)
		const scaled = scaler.body(original)
		const paragraph = scaled.paragraphs[0] as Paragraph
		const sizeOf = (run: Paragraph["runs"][number]): number | undefined => (run.kind === "opaque" ? undefined : run.rPr.sz)
		const rPrOf = (run: Paragraph["runs"][number] | undefined): unknown =>
			run === undefined || run.kind === "opaque" ? undefined : run.rPr

		expect(paragraph.runs.map(sizeOf)).toEqual([1000, 900])
		expect(paragraph.endRPr?.sz).toBe(1200)
		expect(paragraph.pPr.marL).toBe(171_450)
		expect(paragraph.pPr.spcBef).toEqual({ pts: 300 })

		const back = new ContentScaler(undefined, scaler.values).body(scaled).paragraphs[0] as Paragraph
		const source = original.paragraphs[0] as Paragraph

		expect(back.pPr).toBe(source.pPr)
		expect(back.endRPr).toBe(source.endRPr)
		expect(back.runs).toHaveLength(2)
		expect(rPrOf(back.runs[0])).toBe(rPrOf(source.runs[0]))
		expect(rPrOf(back.runs[1])).toBe(rPrOf(source.runs[1]))
	})

	it("restores a filled list style to the levels it had", () => {
		const list: ListStyle = { levels: [{ marL: 0 }, undefined] }
		const scaler = new ContentScaler(2)
		const scaled = scaler.listStyle(list, true)

		expect(scaled.levels).toHaveLength(9)
		expect(scaled.levels[1]?.defRPr?.sz).toBe(3600)

		const restored = new ContentScaler(undefined, scaler.values).listStyle(scaled, true)

		expect(restored.levels).toHaveLength(2)
		expect(restored.levels[0]).toBe(list.levels[0])
		expect(restored.levels[1]).toBeUndefined()
	})
})
