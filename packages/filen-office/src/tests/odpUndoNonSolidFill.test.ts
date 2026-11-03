import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { modelVsFile } from "./modelVsFile"

// A shape's gradient or bitmap fill replaced by a solid one, saved, then undone: the save after the undo writes the
// shape's fill as its source had it (the style the first save retired names the fill's drawing resource), and the
// session keeps saving.

const SOLID = { kind: "solid", color: { kind: "srgb", rgb: "4472C4" } } as const

async function opened(name: string) {
	const d = await driveSession(new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", name))), "odp")

	await odpParts(d.session.deck)?.parseAll()

	const slide = d.session.deck.slides[0] as SlideRef
	const shapes = (d.session.deck.nodes.get(slide)?.shapes ?? []) as ShapeNode[]

	return { d, slide, shapes }
}

const fillOf = (d: Awaited<ReturnType<typeof driveSession>>, slide: SlideRef, id: number) =>
	d.session.deck.nodes.get(slide)?.shapes.find(shape => shape.id === id)?.props?.fill

const has = (name: string): boolean => existsSync(join(CORPUS_DIR, "odp", name))

describe("a non-solid ODP fill replaced, saved and undone", () => {
	it.runIf(has("lo__fillbitmap2.odp"))(
		"a bitmap fill: the save after the undo writes it again, and reopens with it",
		{ timeout: 120_000 },
		async () => {
			const { d, slide, shapes } = await opened("lo__fillbitmap2.odp")
			const shape = shapes.find(each => typeof each.props?.fill === "object" && each.props.fill.kind === "picture") as ShapeNode
			const before = fillOf(d, slide, shape.id)

			expect(
				(await d.command({ family: "shape", kind: "setProps", target: { slide, id: shape.id }, props: { fill: SOLID } })).ok
			).toBe(true)
			expect((await d.save()).result).toEqual(expect.objectContaining({ kind: "written" }))
			expect((await d.undo()).ok).toBe(true)

			const saved = await d.save()

			expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))
			expect(await modelVsFile(d, saved.bytes as Uint8Array, "odp")).toBe("")

			const again = await opened2(saved.bytes as Uint8Array)

			expect(fillOf(again.d, again.slide, shape.id)).toEqual(before)
		}
	)

	it.runIf(has("lo__invalidXmlBy.odp"))(
		"a gradient fill: undone after a save, then another shape filled, every later save is written",
		{ timeout: 120_000 },
		async () => {
			const { d, slide, shapes } = await opened("lo__invalidXmlBy.odp")
			const [a, b] = ["Freeform 24", "Freeform 26"].map(name => shapes.find(each => each.name === name) as ShapeNode)
			const before = fillOf(d, slide, a?.id as number)

			expect(typeof before === "object" && before.kind).toBe("gradient")
			expect(
				(await d.command({ family: "shape", kind: "setProps", target: { slide, id: a?.id as number }, props: { fill: SOLID } })).ok
			).toBe(true)
			expect((await d.save()).result).toEqual(expect.objectContaining({ kind: "written" }))
			expect((await d.undo()).ok).toBe(true)
			expect(
				(await d.command({ family: "shape", kind: "setProps", target: { slide, id: b?.id as number }, props: { fill: SOLID } })).ok
			).toBe(true)

			for (let n = 0; n < 2; n++) {
				const saved = await d.save()

				expect(saved.result).toEqual(expect.objectContaining({ kind: expect.stringMatching(/^(written|unchanged)$/u) }))
				if (saved.bytes !== undefined) expect(await modelVsFile(d, saved.bytes, "odp")).toBe("")
			}

			expect(fillOf(d, slide, a?.id as number)).toEqual(before)
		}
	)
})

async function opened2(bytes: Uint8Array) {
	const d = await driveSession(bytes, "odp")

	await odpParts(d.session.deck)?.parseAll()

	return { d, slide: d.session.deck.slides[0] as SlideRef }
}
