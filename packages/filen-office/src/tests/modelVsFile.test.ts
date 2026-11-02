import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { modelVsFile, reopened } from "./modelVsFile"
import { odpBytes } from "./odpFixtures"

// The checker compares boxes as drawn: a group moved, then one of its members moved far out, reads back with another
// child space but the same drawing, which is no difference; a member the file draws elsewhere is one.

const PAGE =
	'<draw:page draw:name="One" draw:master-page-name="M"><draw:g>' +
	'<draw:frame draw:name="A" svg:x="2cm" svg:y="2cm" svg:width="4cm" svg:height="2cm"><draw:text-box><text:p>A</text:p></draw:text-box></draw:frame>' +
	'<draw:frame draw:name="B" svg:x="7cm" svg:y="5cm" svg:width="3cm" svg:height="2cm"><draw:text-box><text:p>B</text:p></draw:text-box></draw:frame>' +
	"</draw:g></draw:page>"

async function opened(): Promise<{
	readonly d: Awaited<ReturnType<typeof reopened>>
	readonly slide: SlideRef
	readonly group: ShapeNode
}> {
	const d = await reopened(odpBytes({ body: PAGE }), "odp")
	const slide = d.session.deck.slides[0] as SlideRef

	await review(d.context, slide)

	return { d, slide, group: (d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode }
}

async function moved(d: Awaited<ReturnType<typeof reopened>>, slide: SlideRef, shape: ShapeNode, dx: number): Promise<void> {
	const box = shape.xfrm as Xfrm

	expect(
		(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: shape.id }, xfrm: { ...box, x: box.x + dx } })).ok
	).toBe(true)
}

function current(d: Awaited<ReturnType<typeof reopened>>, slide: SlideRef, id: number): ShapeNode {
	const find = (shapes: readonly ShapeNode[]): ShapeNode | undefined => {
		for (const shape of shapes) {
			if (shape.id === id) return shape

			const found = shape.children === undefined ? undefined : find(shape.children)

			if (found !== undefined) return found
		}

		return undefined
	}

	return find((d.session.deck.nodes.get(slide) as SlideNode).shapes) as ShapeNode
}

describe("modelVsFile", () => {
	it("odp: a group moved, then a member moved far out, saved: no difference", async () => {
		const { d, slide, group } = await opened()
		const member = (group.children ?? [])[0] as ShapeNode

		await moved(d, slide, group, 381_000)
		await moved(d, slide, current(d, slide, member.id), -3_000_000)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")
		expect(await modelVsFile(d, saved.bytes as Uint8Array, "odp")).toBe("")
	})

	it("odp: a member moved after the save is a difference", async () => {
		const { d, slide, group } = await opened()
		const saved = await d.save()
		const member = (group.children ?? [])[0] as ShapeNode

		await moved(d, slide, group, 381_000)

		const before = await d.save()

		expect(before.result.kind).toBe("written")
		await moved(d, slide, current(d, slide, member.id), 360_000)
		expect(saved.result.kind).toBe("unchanged")
		expect(await modelVsFile(d, before.bytes as Uint8Array, "odp")).not.toBe("")
	})
})
