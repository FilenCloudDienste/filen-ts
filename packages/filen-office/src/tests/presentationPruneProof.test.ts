import { describe, expect, it, vi } from "vitest"
import type { ShapeNode, SlideNode, Xfrm } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences, partsOf } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"

// The save's proof judges what the prune would leave out: a part the written package still needs stays, and the save
// is written rather than refused (here the prune is made to name parts the slide uses: every part it would keep, or
// only a diagram's drawing, which the slide relates for its data alone).

const wrong = vi.hoisted(() => ({ only: undefined as RegExp | undefined }))

vi.mock("../dom/presentation/prune", async original => {
	const actual = await original<typeof import("../dom/presentation/prune")>()

	return {
		...actual,
		prunePlan: async (session: Parameters<typeof actual.prunePlan>[0]) => {
			const plan = await actual.prunePlan(session)

			const only = wrong.only

			return only === undefined
				? { prune: [...plan.prune, ...plan.keep], keep: [] }
				: { prune: [...plan.prune, ...plan.keep.filter(name => only.test(name))], keep: plan.keep.filter(name => !only.test(name)) }
		}
	}
})

const BOX: Xfrm = {
	x: 1_000_000,
	y: 1_000_000,
	cx: 3_000_000,
	cy: 2_000_000,
	rot: 0,
	flipH: false,
	flipV: false
}

describe("a part the prune would leave out that the save's proof needs", () => {
	it("is kept and the save written", async () => {
		const d = await driveSession(
			buildPptx({
				slides: [
					{
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("P")))
					}
				]
			}),
			"pptx"
		)
		const slide = d.session.deck.slides[0] as SlideNode["ref"]
		const shape = {
			id: 0,
			name: "Picture",
			hidden: false,
			kind: "pic",
			xfrm: BOX
		} as ShapeNode

		expect(
			(
				await d.command({
					family: "picture",
					kind: "insert",
					slide,
					shape,
					image: image(37, 8)
				})
			).ok
		).toBe(true)
		expect((await d.save()).result.kind).toBe("written")

		const id = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.name === "Picture")?.id ?? 0

		expect(
			(
				await d.command({
					family: "shape",
					kind: "setXfrm",
					target: { slide, id },
					xfrm: { ...BOX, x: 2_000_000 }
				})
			).ok
		).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		if (saved.bytes === undefined) throw new Error("not saved")

		expect(await danglingReferences(saved.bytes)).toEqual([])
		expect([...(await partsOf(saved.bytes)).keys()].filter(name => name.startsWith("ppt/media/"))).toHaveLength(1)
	})

	it("keeps a diagram's drawing its data names, and the save is written whole", async () => {
		const d = await driveSession(
			buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("P"))) }] }),
			"pptx"
		)
		const slide = d.session.deck.slides[0] as SlideNode["ref"]

		smartArtRenderer(d.session, {
			services: {
				xml: part => pptxParts(d.session.deck)?.document(part),
				relationship: () => undefined,
				contentType: () => undefined
			}
		})
		expect(
			(
				await d.command({
					family: "smartart",
					kind: "insert",
					slide,
					shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
					layout: { uniqueId: "urn:filen:smartart:layout:list-basic", source: "gallery" },
					texts: ["Alpha", "Beta"]
				})
			).ok
		).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: 2 }, xfrm: { ...BOX, x: 2_000_000 } })).ok).toBe(
			true
		)

		wrong.only = /^ppt\/diagrams\/drawing/u

		const saved = await d.save()

		wrong.only = undefined

		expect(saved.result.kind).toBe("written")

		if (saved.bytes === undefined) throw new Error("not saved")

		expect(await danglingReferences(saved.bytes)).toEqual([])
		expect([...(await partsOf(saved.bytes)).keys()].filter(name => /^ppt\/diagrams\/drawing/u.test(name))).toHaveLength(1)
	})
})
