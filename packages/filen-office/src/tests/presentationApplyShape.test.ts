import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyOp, type ApplyContext } from "../core/presentation/edit/apply"
import { digestOf } from "../core/presentation/edit/changes"
import type { DeckOp } from "../core/presentation/edit/ops"
import { nextShapeId } from "../core/presentation/ids"
import { slideRef, type ShapeNode, type SlideRef } from "../core/presentation/model"
import { TIMING_XML } from "./animFixtures"
import { FIXTURE_FIRST_SLIDE, fixtureDeck } from "./fixtures/presentation/deck"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { tableFrame } from "./presentationObjectsFixtures"
import { viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { installTestRealm } from "./presentationExportFixtures"

// Inserting shapes on the model: ids stay unique on the slide, whatever the page sent.

function ids(shapes: readonly ShapeNode[], into: number[] = []): number[] {
	for (const shape of shapes) {
		into.push(shape.id)
		ids(shape.children ?? [], into)
	}

	return into
}

describe("shape insert", () => {
	it("gives each id-less child of an inserted group its own id", () => {
		const deck = fixtureDeck()
		const slide = slideRef(FIXTURE_FIRST_SLIDE)
		const context: ApplyContext = {
			sourceBytes: () => new Uint8Array(0),
			newShapeId: (ref: SlideRef) => nextShapeId(deck.nodes.get(ref)?.shapes ?? []),
			newSlideRef: () => slideRef(99)
		}
		const child = (name: string): ShapeNode => ({
			id: 0,
			name,
			hidden: false,
			kind: "sp",
			xfrm: { x: 0, y: 0, cx: 10, cy: 10, rot: 0, flipH: false, flipV: false }
		})
		const group: ShapeNode = { id: 0, name: "G", hidden: false, kind: "grpSp", children: [child("a"), child("b"), child("c")] }

		expect(applyOp(deck, { family: "shape", kind: "insert", slide, shape: group }, context).kind).toBe("applied")

		const all = ids(deck.nodes.get(slide)?.shapes ?? [])

		expect(new Set(all).size).toBe(all.length)
		expect(all.every(id => id > 0)).toBe(true)
	})
})

// A slide whose title (2), body (3) and box (4, or a table) PowerPoint animates, and a box (5) it does not; its second
// layout has the body placeholder at another idx, so a layout change renumbers it.
function animatedDeck(table = false): Uint8Array {
	return buildPptx({
		layouts: [
			{ name: "Body at 1", type: "obj", shapes: sp(2, "Title", 'type="title"') + sp(3, "Body", 'type="body" idx="1"') },
			{ name: "Body at 12", type: "obj", shapes: sp(2, "Title", 'type="title"') + sp(3, "Body", 'type="body" idx="12"') }
		],
		slides: [
			{
				shapes:
					sp(2, "Title", 'type="title"', xfrm(100, 100, 5000000, 800000), body(para("Animated"))) +
					sp(3, "Body", 'type="body" idx="1"', xfrm(100, 1000000, 5000000, 3000000), body(para("One") + para("Two"))) +
					(table
						? tableFrame(4, [
								["A1", "B1"],
								["A2", "B2"]
							])
						: sp(
								4,
								"Box",
								undefined,
								`${xfrm(6000000, 1000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
							)) +
					sp(5, "Still", undefined, `${xfrm(6000000, 3000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`),
				after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${TIMING_XML}`
			},
			{ shapes: sp(2, "Title", 'type="title"', "", body(para("Other"))), layout: 2 }
		]
	})
}

describe("an undo that puts shapes back by delete and insert", () => {
	type Drive = Awaited<ReturnType<typeof driveSession>>

	beforeAll(installTestRealm)
	afterAll(() => installPresentationRealm(undefined))

	const opened = async (table?: boolean): Promise<{ readonly d: Drive; readonly slide: SlideRef }> => {
		const d = await driveSession(animatedDeck(table), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await viewCapability.render(d.context, [slide])

		return { d, slide }
	}

	const timingOf = (d: Drive, slide: SlideRef): string => digestOf(d.session.deck.nodes.get(slide)?.timing)

	// `setup` runs first, its state the one the undo must come back to.
	const cases: readonly {
		readonly name: string
		readonly table?: boolean
		readonly setup?: (slide: SlideRef, d: Drive) => DeckOp
		readonly op: (slide: SlideRef, d: Drive) => DeckOp
	}[] = [
		{ name: "Bring to Front", op: slide => ({ family: "shape", kind: "zOrder", slide, shapes: [2], to: "front" }) },
		{ name: "Group", op: slide => ({ family: "shape", kind: "group", slide, shapes: [4, 5] }) },
		{
			name: "Ungroup",
			setup: slide => ({ family: "shape", kind: "group", slide, shapes: [4, 5], id: 20 }),
			op: slide => ({ family: "shape", kind: "ungroup", slide, group: 20 })
		},
		{
			name: "a fill on a file-backed shape",
			op: slide => ({
				family: "shape",
				kind: "setProps",
				target: { slide, id: 4 },
				props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } }
			})
		},
		{
			name: "a table edit",
			table: true,
			setup: slide => ({ family: "table", kind: "insertRows", target: { slide, id: 4 }, at: 1, count: 1 }),
			op: slide => ({ family: "table", kind: "insertRows", target: { slide, id: 4 }, at: 1, count: 1 })
		},
		{
			name: "a layout change that renumbers a placeholder",
			op: (slide, d) => ({ family: "slide", kind: "setLayout", slide, layout: d.session.deck.layouts[1] as SlideRef })
		}
	]

	for (const { name, table, setup, op } of cases) {
		it(`of ${name} keeps the shapes' animations`, async () => {
			const { d, slide } = await opened(table)

			if (setup !== undefined) expect(await d.command(setup(slide, d))).toMatchObject({ ok: true })

			const before = timingOf(d, slide)

			expect(d.session.deck.nodes.get(slide)?.timing).toBeDefined()
			expect(await d.command(op(slide, d))).toMatchObject({ ok: true })
			expect(await d.undo()).toMatchObject({ ok: true })
			expect(timingOf(d, slide)).toBe(before)
			expect(await d.redo()).toMatchObject({ ok: true })
			expect(await d.undo()).toMatchObject({ ok: true })
			expect(timingOf(d, slide)).toBe(before)
		})
	}

	it("of a layout change renumbers the placeholder", async () => {
		const { d, slide } = await opened()
		const body = (): number | undefined => d.session.deck.nodes.get(slide)?.shapes.find(shape => shape.id === 3)?.ph?.idx

		expect(await d.command({ family: "slide", kind: "setLayout", slide, layout: d.session.deck.layouts[1] as SlideRef })).toMatchObject(
			{ ok: true }
		)
		expect(body()).toBe(12)
		expect(await d.undo()).toMatchObject({ ok: true })
		expect(body()).toBe(1)
	})

	it("but a user delete takes the effects out, and its undo puts them back", async () => {
		const { d, slide } = await opened()
		const before = timingOf(d, slide)

		expect(await d.command({ family: "shape", kind: "delete", slide, shapes: [4] })).toMatchObject({ ok: true })
		expect(timingOf(d, slide)).not.toBe(before)
		expect(await d.undo()).toMatchObject({ ok: true })
		expect(timingOf(d, slide)).toBe(before)
	})
})
