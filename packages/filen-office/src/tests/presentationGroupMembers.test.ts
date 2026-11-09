import { describe, expect, it } from "vitest"
import type { ApplyContext, Inverse } from "../core/presentation/edit/apply"
import { applyShape } from "../core/presentation/edit/apply/shape"
import { duplicateOp, xfrmsOp } from "../core/presentation/edit/commands/shape"
import type { DeckOp, ShapeOp } from "../core/presentation/edit/ops"
import {
	childFromParent,
	childInParent,
	fittedGroupXfrm,
	holdingGroups,
	ownDelta,
	ownThrough,
	shownThrough,
	toParent
} from "../core/presentation/groupSpace"
import { slideRef, type Deck, type ShapeNode, type SlideNode, type Xfrm } from "../core/presentation/model"
import { renderSlide } from "../core/presentation/render/slide"
import { SLIDE, THEME, THEME_PART, deckOf as deckOfRender, renderServices } from "./fixtures/presentation/renderDeck"

// Editing a group's members in place: their boxes between the slide and the group's child space, and a pptx group
// fitted to its members (PowerPoint keeps a group's box at its members' bounds) without anything moving on the slide.

const xfrm = (x: number, y: number, cx: number, cy: number, extra: Partial<Xfrm> = {}): Xfrm => ({
	x,
	y,
	cx,
	cy,
	rot: 0,
	flipH: false,
	flipV: false,
	...extra
})

const CONTEXT = { newShapeId: () => 100 } as unknown as ApplyContext

function close(a: Xfrm, b: Xfrm, slack = 2): void {
	expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(slack)
	expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(slack)
	expect(Math.abs(a.cx - b.cx)).toBeLessThanOrEqual(slack)
	expect(Math.abs(a.cy - b.cy)).toBeLessThanOrEqual(slack)
	expect(a.rot).toBe(b.rot)
	expect(a.flipH).toBe(b.flipH)
	expect(a.flipV).toBe(b.flipV)
}

describe("a member's box between the slide and its group's child space", () => {
	const groups: readonly Xfrm[] = [
		xfrm(1000, 2000, 4000, 2000, { chX: 0, chY: 0, chCx: 2000, chCy: 1000 }),
		xfrm(1000, 2000, 4000, 2000, { rot: 5_400_000, chX: 500, chY: 500, chCx: 4000, chCy: 4000 }),
		xfrm(1000, 2000, 4000, 2000, { flipH: true, rot: 1_800_000, chX: 0, chY: 0, chCx: 8000, chCy: 4000 }),
		xfrm(1000, 2000, 4000, 2000)
	]
	const child = xfrm(200, 300, 600, 400, { rot: 600_000, flipV: true })

	it("goes back to the member's own box exactly for scaled, turned and mirrored groups", () => {
		for (const group of groups) close(childFromParent(group, childInParent(group, child)), child)
	})

	it("through nested groups, outermost first", () => {
		const outer = groups[1] as Xfrm
		const inner = xfrm(100, 100, 1000, 800, { chX: 0, chY: 0, chCx: 2000, chCy: 1600, flipH: true })
		const shown = shownThrough([outer, inner], child)

		expect(shown).toEqual(childInParent(outer, childInParent(inner, child)))
		close(ownThrough([outer, inner], shown), child)
	})

	it("takes a move on the slide into the group's scale and turn", () => {
		// Scaled 2×: 100 EMU on the slide is 50 in the child space.
		expect(ownDelta([groups[0] as Xfrm], 100, 0)).toEqual({ dx: 50, dy: 0 })
		// Turned a quarter clockwise: a move right on the slide is a move up in the child space.
		const turned = ownDelta([xfrm(0, 0, 1000, 1000, { rot: 5_400_000 })], 100, 0)

		expect(turned.dx).toBe(0)
		expect(turned.dy).toBe(-100)
	})
})

describe("a group fitted to its members", () => {
	it("keeps every member where it shows on the slide, turned and scaled", () => {
		const group: ShapeNode = {
			id: 2,
			name: "Group",
			hidden: false,
			kind: "grpSp",
			xfrm: xfrm(1000, 1000, 2000, 2000, { rot: 1_800_000, chX: 0, chY: 0, chCx: 1000, chCy: 1000 }),
			children: [
				{ id: 3, name: "a", hidden: false, kind: "sp", xfrm: xfrm(0, 0, 400, 400) },
				{ id: 4, name: "b", hidden: false, kind: "sp", xfrm: xfrm(900, 700, 600, 500) }
			]
		}
		const before = (group.children ?? []).map(member => shownThrough([group.xfrm as Xfrm], member.xfrm as Xfrm))
		const fitted = fittedGroupXfrm(group) as Xfrm

		expect(fitted).toMatchObject({ chX: 0, chY: 0, chCx: 1500, chCy: 1200, rot: 1_800_000 })
		expect(fitted.cx).toBe(3000)
		;(group.children ?? []).forEach((member, k) => {
			close(shownThrough([fitted], member.xfrm as Xfrm), before[k] as Xfrm)
		})
	})

	it("leaves a group that already fits", () => {
		const group: ShapeNode = {
			id: 2,
			name: "Group",
			hidden: false,
			kind: "grpSp",
			xfrm: xfrm(0, 0, 100, 100, { chX: 0, chY: 0, chCx: 100, chCy: 100 }),
			children: [{ id: 3, name: "a", hidden: false, kind: "sp", xfrm: xfrm(0, 0, 100, 100) }]
		}

		expect(fittedGroupXfrm(group)).toBeUndefined()
	})

	it("lists the groups holding a shape innermost first", () => {
		const inner: ShapeNode = {
			id: 3,
			name: "",
			hidden: false,
			kind: "grpSp",
			children: [{ id: 4, name: "", hidden: false, kind: "sp" }]
		}
		const outer: ShapeNode = { id: 2, name: "", hidden: false, kind: "grpSp", children: [inner] }

		expect(holdingGroups([outer], new Set([4])).map(group => group.id)).toEqual([3, 2])
	})
})

function deckOf(format: "pptx" | "odp", turn = 0): { readonly deck: Deck; readonly node: SlideNode; readonly group: ShapeNode } {
	const ref = slideRef(256)
	const group: ShapeNode = {
		id: 2,
		name: "Group",
		hidden: false,
		kind: "grpSp",
		xfrm: xfrm(1000, 1000, 2000, 1000, { rot: turn, chX: 0, chY: 0, chCx: 1000, chCy: 500 }),
		children: [
			{ id: 3, name: "a", hidden: false, kind: "sp", xfrm: xfrm(0, 0, 400, 200) },
			{ id: 4, name: "b", hidden: false, kind: "sp", xfrm: xfrm(600, 300, 400, 200) }
		]
	}
	const node = {
		ref,
		kind: "slide",
		part: "/ppt/slides/slide1.xml",
		shapes: [group],
		comments: [],
		revision: 0,
		showMasterShapes: true,
		hidden: false
	} as unknown as SlideNode
	const deck = { gate: [], format, size: { cx: 12_192_000, cy: 6_858_000 }, nodes: new Map([[ref, node]]) } as unknown as Deck

	return { deck, node, group }
}

function apply(deck: Deck, op: DeckOp): Inverse {
	const result = applyShape.apply(deck, op as ShapeOp, CONTEXT)

	if (result.kind !== "applied") throw new Error(`refused: ${result.reason}`)

	return result.inverse
}

function undo(deck: Deck, inverse: Inverse): void {
	for (const op of inverse.ops) apply(deck, op)
}

describe("moving a group's member (pptx)", () => {
	it("fits the group to its members in the same step, and the undo puts both boxes back exactly", () => {
		const { deck, node, group } = deckOf("pptx")
		const priorGroup = structuredClone(group.xfrm)
		const member = group.children?.[1] as ShapeNode
		const inverse = apply(deck, {
			family: "shape",
			kind: "setXfrm",
			target: { slide: node.ref, id: 4 },
			xfrm: xfrm(1400, 300, 400, 200)
		})

		// The member reaches past the old child extent: the group grows to hold it, scale kept.
		expect(group.xfrm).toMatchObject({ x: 1000, y: 1000, cx: 3600, cy: 1000, chX: 0, chY: 0, chCx: 1800, chCy: 500 })
		expect(inverse.ops.at(-1)).toMatchObject({ kind: "setXfrms", exact: true, xfrms: [{ id: 2, xfrm: priorGroup }] })

		undo(deck, inverse)

		expect(member.xfrm).toEqual(xfrm(600, 300, 400, 200))
		expect(group.xfrm).toEqual(priorGroup)
	})

	it("keeps an ODP group to its own refit (members' bounds through a straight mapping)", () => {
		const { deck, node, group } = deckOf("odp")
		const inverse = apply(deck, {
			family: "shape",
			kind: "setXfrm",
			target: { slide: node.ref, id: 4 },
			xfrm: xfrm(1400, 300, 400, 200)
		})

		expect(inverse.ops.some(op => op.family === "shape" && op.kind === "setXfrms" && op.exact === true)).toBe(false)
		expect(group.xfrm?.cx).toBe(3600)
	})

	it("an exact setXfrms fits nothing", () => {
		const { deck, node, group } = deckOf("pptx")
		const prior = structuredClone(group.xfrm)

		apply(deck, {
			family: "shape",
			kind: "setXfrms",
			slide: node.ref,
			exact: true,
			xfrms: [{ id: 4, xfrm: xfrm(1400, 300, 400, 200) }]
		})

		expect(group.xfrm).toEqual(prior)
	})

	it("fits the group after a member is deleted or duplicated, and the undo restores it", () => {
		const { deck, node, group } = deckOf("pptx")
		const prior = structuredClone(group.xfrm)
		const removed = apply(deck, { family: "shape", kind: "delete", slide: node.ref, shapes: [4] })

		expect(group.xfrm).toMatchObject({ cx: 800, cy: 400, chCx: 400, chCy: 200 })

		expect(removed.ops.at(-1)).toMatchObject({ kind: "setXfrms", exact: true })

		undo(deck, removed)

		expect(group.xfrm).toEqual(prior)
		expect(group.children?.map(member => member.id)).toEqual([3, 4])

		const copied = apply(deck, { family: "shape", kind: "duplicate", slide: node.ref, shapes: [4], dx: 400, dy: 0 })

		expect(group.xfrm).toMatchObject({ cx: 2800, chCx: 1400 })

		undo(deck, copied)

		expect(group.xfrm).toEqual(prior)
	})

	it("the editor's ops write a member's slide box in the group's child space", () => {
		const { node, group } = deckOf("pptx", 0)
		const space = [group.xfrm as Xfrm]
		const own = (group.children?.[0] as ShapeNode).xfrm as Xfrm
		const shown = shownThrough(space, own)
		const moved = { ...shown, x: shown.x + 200 }
		const op = xfrmsOp(node.ref, [{ id: 3, xfrm: shown, space }], [{ id: 3, xfrm: moved }])

		// Scaled 2× along x: 200 EMU on the slide is 100 in the group.
		expect(op).toMatchObject({ kind: "setXfrm", target: { id: 3 }, xfrm: { x: 100, y: 0, cx: 400, cy: 200 } })
		expect(duplicateOp(node.ref, [3], 200, 100, space)).toMatchObject({ dx: 100, dy: 50 })
		expect(toParent(space[0] as Xfrm, 0, 0)).toEqual({ x: 1000, y: 1000 })
	})
})

describe("aligning a group's members to the slide", () => {
	it("aligns them in the group's child space when the group is not turned", () => {
		const { deck, node, group } = deckOf("pptx")
		const member = group.children?.[0] as ShapeNode

		apply(deck, { family: "shape", kind: "align", slide: node.ref, shapes: [3], edge: "left", relativeTo: "slide" } as DeckOp)

		// The slide's left edge (x 0) is -500 in a child space that starts at x 1000 at scale 2.
		expect(member.xfrm?.x).toBe(-500)
		expect(shownThrough([group.xfrm as Xfrm], member.xfrm as Xfrm).x).toBe(0)
	})

	it("refuses inside a turned group", () => {
		const { deck, node } = deckOf("pptx", 1_800_000)
		const result = applyShape.apply(
			deck,
			{ family: "shape", kind: "align", slide: node.ref, shapes: [3], edge: "left", relativeTo: "slide" } as ShapeOp,
			CONTEXT
		)

		expect(result.kind).toBe("refused")
	})
})

describe("a group's members in the slide's render", () => {
	it("carry their own box and the box they show at, a member group's members nested, hidden ones left out", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } })
		const group = xfrm(0, 0, 2000, 1000, { chX: 0, chY: 0, chCx: 1000, chCy: 1000 })
		const inner = xfrm(500, 0, 500, 500, { chX: 0, chY: 0, chCx: 500, chCy: 500 })
		const deck = deckOfRender(
			[],
			[],
			[
				{
					id: 2,
					name: "Group",
					hidden: false,
					kind: "grpSp",
					xfrm: group,
					children: [
						{ id: 3, name: "a", hidden: false, kind: "sp", txBox: true, xfrm: xfrm(0, 0, 400, 400), locks: { noSelect: true } },
						{ id: 4, name: "line", hidden: false, kind: "cxnSp", xfrm: xfrm(0, 500, 400, 0) },
						{ id: 5, name: "hidden", hidden: true, kind: "sp", xfrm: xfrm(0, 0, 10, 10) },
						{
							id: 6,
							name: "inner",
							hidden: false,
							kind: "grpSp",
							xfrm: inner,
							children: [{ id: 7, name: "b", hidden: false, kind: "sp", xfrm: xfrm(0, 0, 250, 250) }]
						}
					]
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 })
		const members = render.layers.find(layer => layer.box?.id === 2)?.box?.members ?? []

		expect(members.map(each => each.id)).toEqual([3, 4, 6])
		expect(members[0]).toMatchObject({ role: "shape", body: "textBox", locks: { noSelect: true }, own: xfrm(0, 0, 400, 400) })
		expect(members[0]?.xfrm).toMatchObject({ x: 0, y: 0, cx: 800, cy: 400 })
		expect(members[1]).toMatchObject({ line: true })
		expect(members[2]?.members?.[0]?.xfrm).toMatchObject({ x: 1000, y: 0, cx: 500, cy: 250 })
		// The empty text box member has a text layer of its own for the editor to enter.
		expect(render.layers.some(layer => layer.shape.id === 3 && layer.textMatrix !== undefined)).toBe(true)
	})
})
