import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emitPptx } from "../core/pptx/write/emit"
import { alignOp, distributeOp } from "../core/presentation/edit/commands/align"
import { zOrderOp } from "../core/presentation/edit/commands/arrange"
import { groupOp, ungroupOps } from "../core/presentation/edit/commands/group"
import { actionOp, altOp, deleteOp, flipOp, moveOp, nudgeOp, resizedXfrm, rotateOp } from "../core/presentation/edit/commands/shape"
import type { DeckOp } from "../core/presentation/edit/ops"
import { resolveShape } from "../core/presentation/inherit"
import type { ShapeNode, SlideNode, Xfrm } from "../core/presentation/model"
import { renderSlide } from "../core/presentation/render/slide"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { OpenXmlSdk, loadAllowlist, newSdkErrors, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { editDeck, editHarness, shapeById, type EditHarness } from "./presentationEditFixtures"
import { changedParts, saveEdits } from "./pptxWriteFixtures"

// The arrange commands through the edit session with the real pptx emitter: each op changes the model as the
// command says, saves only its slide (and that slide's relationships when a link is added), reads back the same,
// and passes the Open XML SDK validator with no new error (opt-in, FILEN_OFFICE_OOXML_VALIDATOR). The editor's
// boxes come from the render: every layer of a slide's own shape carries its model box.

const EDIT = { emit: emitPptx } as never
const SLICING = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }
const MISSING = openXmlSdkMissing()

function boxOf(slide: SlideNode, id: number): Xfrm {
	const xfrm = shapeById(slide.shapes, id)?.xfrm

	if (xfrm === undefined) throw new Error(`shape ${String(id)} has no box`)

	return xfrm
}

function ids(shapes: readonly ShapeNode[]): number[] {
	return shapes.map(shape => shape.id)
}

async function session(): Promise<{ h: EditHarness; slide: SlideNode }> {
	const h = await editHarness(editDeck(), EDIT)

	return { h, slide: await h.slide(0) }
}

// What every command's save is checked against: only slide 1's part (and its rels) changed, and the bytes re-open
// to the same slide.
async function saved(h: EditHarness): Promise<{ bytes: Uint8Array; slide: SlideNode }> {
	const bytes = await saveEdits(h, sessionEdits(h.session).history.revision)
	const changed = await changedParts(editDeck(), bytes)

	expect(changed.filter(name => name !== "ppt/slides/slide1.xml" && name !== "ppt/slides/_rels/slide1.xml.rels")).toEqual([])

	const reopened = await editHarness(bytes, EDIT)
	const slide = await reopened.slide(0)

	reopened.close()

	return { bytes, slide }
}

const outputs: [name: string, bytes: Uint8Array][] = []

async function check(
	name: string,
	ops: (slide: SlideNode) => readonly (DeckOp | undefined)[],
	verify: (before: SlideNode, after: SlideNode) => void
): Promise<void> {
	const { h, slide } = await session()
	const before = structuredClone(slide.shapes)

	for (const op of ops(slide)) {
		if (op === undefined) throw new Error(`${name}: no op`)

		expect(await h.command(op)).toMatchObject({ ok: true })
	}

	const out = await saved(h)

	verify({ ...slide, shapes: before }, out.slide)
	outputs.push([name, out.bytes])
	h.close()
}

describe("presentation arrange commands in the edit session", () => {
	it("a drag of three shapes is one step: one undo puts all three back, one redo moves them again", async () => {
		const { h, slide } = await session()
		const ref = slide.ref
		const before = [3, 4, 5].map(id => ({ id, xfrm: { ...boxOf(slide, id) } }))
		const op = moveOp(ref, before, 9525 * 10, 9525 * 5)

		expect(op).toMatchObject({ kind: "setXfrms" })
		expect(await h.command(op as DeckOp)).toMatchObject({ ok: true, dirty: true })
		expect([...(sessionEdits(h.session).changes().parts.get(slide.part)?.shapes ?? [])].sort()).toEqual([
			[3, { kind: "xfrm" }],
			[4, { kind: "xfrm" }],
			[5, { kind: "xfrm" }]
		])
		expect(await h.undo()).toMatchObject({ ok: true, dirty: false })
		expect(before.map(entry => boxOf(slide, entry.id))).toEqual(before.map(entry => entry.xfrm))
		expect(await h.redo()).toMatchObject({ ok: true, dirty: true })
		expect(boxOf(slide, 5)).toMatchObject({ x: (before[2]?.xfrm.x ?? 0) + 9525 * 10 })
		h.close()
	})

	it("a setXfrms naming a missing shape or one shape twice refuses and moves nothing", async () => {
		const { h, slide } = await session()
		const a = boxOf(slide, 3)

		expect(
			await h.command({
				family: "shape",
				kind: "setXfrms",
				slide: slide.ref,
				xfrms: [
					{ id: 3, xfrm: { ...a, x: 1 } },
					{ id: 999, xfrm: a }
				]
			})
		).toEqual({ ok: false, refusal: "notFound" })
		expect(
			await h.command({
				family: "shape",
				kind: "setXfrms",
				slide: slide.ref,
				xfrms: [
					{ id: 3, xfrm: a },
					{ id: 3, xfrm: a }
				]
			})
		).toEqual({ ok: false, refusal: "malformed" })
		expect(boxOf(slide, 3)).toEqual(a)
		h.close()
	})

	it("move, resize, nudge, rotate and flip save as boxes and read back", async () => {
		await check(
			"transforms",
			slide => {
				const a = { id: 3, xfrm: boxOf(slide, 3) }
				const b = { id: 4, xfrm: boxOf(slide, 4) }

				return [
					moveOp(slide.ref, [a, b], 9525 * 3, 0),
					{
						family: "shape",
						kind: "setXfrm",
						target: { slide: slide.ref, id: 5 },
						xfrm: resizedXfrm(boxOf(slide, 5), "se", 9525, 9525)
					},
					nudgeOp(slide.ref, [{ id: 5, xfrm: resizedXfrm(boxOf(slide, 5), "se", 9525, 9525) }], "down", true),
					rotateOp(slide.ref, [{ id: 9, xfrm: boxOf(slide, 9) }], 1),
					flipOp(slide.ref, [{ id: 4, xfrm: { ...boxOf(slide, 4), x: boxOf(slide, 4).x + 9525 * 3 } }], "horizontal")
				]
			},
			(before, after) => {
				expect(boxOf(after, 3).x).toBe(boxOf(before, 3).x + 9525 * 3)
				expect(boxOf(after, 4)).toMatchObject({ x: boxOf(before, 4).x + 9525 * 3, flipH: true })
				expect(boxOf(after, 5)).toMatchObject({ cx: boxOf(before, 5).cx + 9525, y: boxOf(before, 5).y + 9525 * 10 })
				expect(boxOf(after, 9).rot).toBe(5_400_000)
			}
		)
	})

	it("align and distribute move only the named shapes", async () => {
		await check(
			"align",
			slide => [alignOp(slide.ref, [3, 4, 5], "top", "selection"), distributeOp(slide.ref, [3, 4, 5], "horizontal", "slide")],
			(before, after) => {
				const top = Math.min(...[3, 4, 5].map(id => boxOf(before, id).y))

				expect([3, 4, 5].map(id => boxOf(after, id).y)).toEqual([top, top, top])
				expect(boxOf(after, 9)).toEqual(boxOf(before, 9))
			}
		)
	})

	it("z-order, group, ungroup and delete restructure the slide", async () => {
		await check(
			"structure",
			slide => [
				zOrderOp(slide.ref, [3], "front"),
				groupOp(slide.ref, [4, 5]),
				...ungroupOps(slide.ref, [{ id: 6, role: "group" }]),
				deleteOp(slide.ref, [9])
			],
			(_before, after) => {
				const top = ids(after.shapes)
				const group = after.shapes.find(shape => shape.kind === "grpSp")

				expect(top[top.length - 1]).toBe(3)
				expect(top).toContain(7)
				expect(top).toContain(8)
				expect(top).not.toContain(6)
				expect(top).not.toContain(9)
				expect(ids(group?.children ?? [])).toEqual([4, 5])
			}
		)
	})

	it("alt text and a click action save and read back; a refused action is never written", async () => {
		await check(
			"alt and action",
			slide => [
				altOp({ slide: slide.ref, id: 3 }, { descr: "Red box", title: "Box" }),
				altOp({ slide: slide.ref, id: 4 }, { decorative: true }),
				actionOp({ slide: slide.ref, id: 9 }, "click", { kind: "url", href: "https://filen.io/" }),
				actionOp({ slide: slide.ref, id: 5 }, "click", undefined)
			],
			(_before, after) => {
				expect(shapeById(after.shapes, 3)?.alt).toEqual({ descr: "Red box", title: "Box" })
				expect(shapeById(after.shapes, 4)?.alt).toMatchObject({ decorative: true })
				expect(shapeById(after.shapes, 9)?.actions?.click).toEqual({ kind: "url", href: "https://filen.io/" })
				expect(shapeById(after.shapes, 5)?.actions?.click).toBeUndefined()
			}
		)
		expect(
			actionOp({ slide: (await session()).slide.ref, id: 3 }, "click", { kind: "refused", what: "macro", raw: "x" })
		).toBeUndefined()
	})
})

describe("the render carries each slide shape's box for the editor", () => {
	it("as the model resolves it: a shape's own box, a placeholder's inherited one, a group's whole", async () => {
		const opened = await openRenderDeck(editDeck())

		if (opened === undefined) throw new Error("open")

		const { deck, services } = opened
		const ref = deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		const node = deck.nodes.get(ref) as SlideNode
		const render = await renderSlide(deck, ref, services, SLICING)
		const boxes = new Map<number, Xfrm>()

		for (const layer of render.layers) {
			if (layer.role === "master" || layer.role === "layout") expect(layer.box).toBeUndefined()
			if (layer.box !== undefined) boxes.set(layer.box.id, layer.box.xfrm)
		}

		expect(boxes.get(3)).toEqual(boxOf(node, 3))
		expect(boxes.get(6)).toEqual(boxOf(node, 6))
		expect(boxes.has(7)).toBe(false)

		const title = node.shapes.find(shape => shape.id === 2) as ShapeNode

		expect(title.xfrm).toBeUndefined()
		expect(boxes.get(2)).toEqual(resolveShape(deck, ref, title).xfrm)
	})
})

describe.skipIf(MISSING !== undefined)("arrange outputs under the Open XML SDK validator", () => {
	let sdk: OpenXmlSdk
	let scratch: string

	beforeAll(() => {
		sdk = new OpenXmlSdk()
		scratch = mkdtempSync(join(tmpdir(), "filen-office-arrange-"))
	})

	afterAll(async () => {
		await sdk.close()
		rmSync(scratch, { recursive: true, force: true })
	})

	it("every saved output has no error the source did not have", async () => {
		const source = join(scratch, "source.pptx")

		writeFileSync(source, editDeck())

		const before = sdkErrorCounts(await sdk.validate(source))
		const allow = loadAllowlist()

		expect(outputs.length).toBeGreaterThan(0)

		for (const [name, bytes] of outputs) {
			const path = join(scratch, `${name.replace(/\W+/gu, "-")}.pptx`)

			writeFileSync(path, bytes)
			expect([name, newSdkErrors(before, sdkErrorCounts(await sdk.validate(path)), allow)]).toEqual([name, []])
		}
	})
})
