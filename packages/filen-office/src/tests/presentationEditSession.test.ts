import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openPptx } from "../core/pptx/package"
import { digestOf } from "../core/presentation/edit/changes"
import type { ShapeNode } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { saveCapability } from "../dom/presentation/engine/save"
import { sessionEdits } from "../dom/presentation/engine/edit"
import type { PortLike } from "../dom/presentation/protocol"
import { BROKEN_EMITTER, editDeck, editDeckOptions, editHarness, shapeById } from "./presentationEditFixtures"
import { buildPptx } from "./pptxFixtures"

const typedOf = (shape: ShapeNode | undefined): string => {
	if (shape === undefined) return "absent"

	const { src: _src, ...rest } = shape

	return digestOf(rest)
}

describe("presentation edit session", () => {
	it("an edit undone back to the saved state leaves no changes, and the save answers unchanged with no upload", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)
		const before = shapeById(slide.shapes, 3)?.xfrm

		const moved = await harness.command({
			family: "shape",
			kind: "setXfrm",
			target: { slide: slide.ref, id: 3 },
			xfrm: { x: 900, y: 900, cx: 1000, cy: 500, rot: 0, flipH: false, flipV: false }
		})

		expect(moved).toMatchObject({ ok: true, dirty: true })

		const changes = sessionEdits(harness.session).changes()

		expect(changes.empty).toBe(false)
		expect([...(changes.parts.get(slide.part)?.shapes ?? [])]).toEqual([[3, { kind: "xfrm" }]])

		expect(await harness.undo()).toMatchObject({ ok: true, dirty: false })
		expect(shapeById(slide.shapes, 3)?.xfrm).toEqual(before)
		expect(sessionEdits(harness.session).changes().empty).toBe(true)

		const channel = new MessageChannel()
		const port = channel.port1 as unknown as PortLike

		channel.port2.unref()
		channel.port1.unref()

		expect(await saveCapability.save(harness.context, { reason: "user", port })).toEqual({ kind: "unchanged" })
		channel.port1.close()
		channel.port2.close()
		harness.close()
	})

	it("redo of an undone edit is dirty again, and a new op after undo discards the redo branch", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)
		const target = { slide: slide.ref, id: 4 }

		await harness.command({ family: "shape", kind: "setAlt", target, alt: { descr: "first" } })
		await harness.undo()
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		expect(await harness.redo()).toMatchObject({ ok: true, dirty: true })
		await harness.undo()
		await harness.command({ family: "shape", kind: "setAlt", target, alt: { descr: "second" } })
		expect(sessionEdits(harness.session).history.canRedo).toBe(false)
		expect(shapeById(slide.shapes, 4)?.alt).toEqual({ descr: "second" })
		harness.close()
	})

	it.each([
		["held", true],
		["dropped by the rebase", false]
	])(
		"an undone delete of a shape after a rebase restores the identical element from the bytes its inverse holds (slide document %s)",
		async (_name, held) => {
			const harness = await editHarness(editDeck())
			const slide = await harness.slide(0)
			const parts = pptxParts(harness.session.deck)

			if (parts === undefined) throw new Error("no parts")

			const original = shapeById(slide.shapes, 3) as ShapeNode
			const originalTyped = typedOf(original)
			const document = parts.document(slide.part)

			if (document === undefined || original.src === undefined) throw new Error("no source")

			const originalBytes = document.raw(original.src.node).slice()

			expect(await harness.command({ family: "shape", kind: "delete", slide: slide.ref, shapes: [3] })).toMatchObject({ ok: true })

			// The save's rebase: the saved file has the slide without the shape, read at the next epoch; every ref the
			// model held into the old document is stale.
			const options = editDeckOptions()
			const saved = buildPptx({
				...options,
				slides: options.slides.map((entry, index) =>
					index === 0
						? { ...entry, shapes: entry.shapes.replace(/<p:sp><p:nvSpPr><p:cNvPr id="3" name="Box A"\/>.*?<\/p:sp>/u, "") }
						: entry
				)
			})
			const reopened = await openPptx(bytesSource(saved), { epoch: 1 })

			if (reopened.kind !== "opened") throw new Error("reopen")

			await reopened.parts.slide(reopened.deck.slides[0] as never)

			const savedDocument = reopened.parts.document(slide.part)

			expect(new TextDecoder().decode(savedDocument?.bytes)).not.toContain('name="Box A"')
			parts.rebase(reopened.parts.opc, reopened.parts.contentTypes, 1, new Map([[slide.part, held ? savedDocument : undefined]]))

			expect(await harness.undo()).toMatchObject({ ok: true })

			const restored = shapeById(slide.shapes, 3) as ShapeNode

			expect(restored.src?.part.startsWith("raw:")).toBe(true)
			expect(typedOf(restored)).toBe(originalTyped)

			const kept = sessionEdits(harness.session).rawDocument(restored.src?.part ?? "")

			// The package answers the held document too, so the renderer and the emitters resolve the restored refs.
			expect(parts.document(restored.src?.part ?? "")).toBe(kept)

			expect(kept?.raw(restored.src?.node ?? 0)).toEqual(originalBytes)
			expect(slide.shapes.map(shape => shape.id)).toEqual([2, 3, 4, 5, 6, 9])
			expect(sessionEdits(harness.session).history.dirty).toBe(false)
			harness.close()
		}
	)

	it("a shape whose writer proof fails is locked: its content is refused, its box still moves, and the page is told", async () => {
		const harness = await editHarness(editDeck(), { emit: BROKEN_EMITTER })
		const slide = await harness.slide(0)
		const target = { slide: slide.ref, id: 3 }

		expect(await harness.command({ family: "shape", kind: "setProps", target, props: { fill: "none" } })).toEqual({
			ok: false,
			refusal: "locked"
		})
		expect(shapeById(slide.shapes, 3)?.lock).toBe("proofFailed")
		expect(harness.events).toContainEqual({ type: "notice", notice: { kind: "lock", shape: target, reason: "proofFailed" } })
		expect(
			await harness.command({
				family: "shape",
				kind: "setXfrm",
				target,
				xfrm: { x: 1, y: 2, cx: 3, cy: 4, rot: 0, flipH: false, flipV: false }
			})
		).toMatchObject({ ok: true })

		const tally = sessionEdits(harness.session).proofs().get(slide.ref)

		expect(tally?.locked.proofFailed).toBeGreaterThan(0)
		harness.close()
	})

	it("an unedited shape the writer reproduces passes gate 1: nothing locks", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)

		await harness.command({ family: "shape", kind: "setAlt", target: { slide: slide.ref, id: 4 }, alt: { title: "t" } })

		const tally = sessionEdits(harness.session).proofs().get(slide.ref)

		expect(tally?.locked).toEqual({})
		expect(tally?.shapes).toBe(8)
		harness.close()
	})

	it("deleting a slide takes it out of its section and custom show and turns jumps to it into next-slide; undo puts all back", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const first = await harness.slide(0)
		const third = deck.slides[2]

		if (third === undefined) throw new Error("no third slide")

		const sectionsBefore = JSON.stringify(deck.sections)
		const showsBefore = JSON.stringify(deck.customShows)

		expect(shapeById(first.shapes, 5)?.actions?.click).toEqual({ kind: "slide", slide: third })
		expect(await harness.command({ family: "slide", kind: "delete", slides: [third] })).toMatchObject({ ok: true, dirty: true })
		expect(deck.slides).toHaveLength(3)
		expect(deck.sections.flatMap(section => section.slides)).not.toContain(third)
		expect(deck.customShows[0]?.slides).not.toContain(third)
		expect(shapeById(first.shapes, 5)?.actions?.click).toEqual({ kind: "internal", jump: "next" })
		expect(harness.events).toContainEqual({
			type: "notice",
			notice: { kind: "jumpsRewritten", count: 1, shapes: [{ slide: first.ref, id: 5 }] }
		})

		const changes = sessionEdits(harness.session).changes()
		const removed = [...changes.parts].filter(([, part]) => part.change === "removed").map(([name]) => name)

		expect(removed).toEqual(["/ppt/slides/slide3.xml"])
		expect([...changes.presentation].sort()).toEqual(["customShows", "sections", "slideList"])

		expect(await harness.undo()).toMatchObject({ ok: true, dirty: false })
		expect(deck.slides[2]).toBe(third)
		expect(JSON.stringify(deck.sections)).toBe(sectionsBefore)
		expect(JSON.stringify(deck.customShows)).toBe(showsBefore)
		expect(shapeById(first.shapes, 5)?.actions?.click).toEqual({ kind: "slide", slide: third })
		harness.close()
	})

	it("a slide's notes go with it and come back with it", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const first = await harness.slide(0)
		const notes = first.notes

		expect(notes).toBeDefined()
		await harness.command({ family: "slide", kind: "delete", slides: [first.ref] })
		expect(deck.nodes.has(notes as never)).toBe(false)

		const removed = [...sessionEdits(harness.session).changes().parts]
			.filter(([, part]) => part.change === "removed")
			.map(([name]) => name)

		expect(removed.sort()).toEqual(["/ppt/notesSlides/notesSlide1.xml", "/ppt/slides/slide1.xml"])
		await harness.undo()
		expect(deck.nodes.get(first.ref)?.notes).toBe(notes)
		expect(deck.nodes.has(notes as never)).toBe(true)
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		harness.close()
	})

	it("a new slide gets the layout's content placeholders, a new part, and the section of the slide before it", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const layout = deck.layouts[0]

		if (layout === undefined) throw new Error("no layout")

		expect(await harness.command({ family: "slide", kind: "add", at: 2, layout })).toMatchObject({ ok: true })

		const added = deck.slides[2]
		const node = added === undefined ? undefined : deck.nodes.get(added)

		expect(node?.part).toBe("/ppt/slides/slide5.xml")
		expect(node?.shapes.map(shape => [shape.name, shape.ph?.type])).toEqual([
			["Title 1", "title"],
			["Content Placeholder 2", "obj"]
		])
		expect(deck.sections[0]?.slides).toContain(added)

		const changes = sessionEdits(harness.session).changes()

		expect(changes.parts.get("/ppt/slides/slide5.xml")?.change).toBe("added")
		await harness.undo()
		expect(deck.slides).toHaveLength(4)
		expect(sessionEdits(harness.session).changes().empty).toBe(true)
		harness.close()
	})

	it("a duplicate shares the source's markup until written, has its own notes, and lands after the source", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const first = await harness.slide(0)

		expect(await harness.command({ family: "slide", kind: "duplicate", slide: first.ref })).toMatchObject({ ok: true })

		const copy = deck.nodes.get(deck.slides[1] as never)

		expect(copy?.part).toBe("/ppt/slides/slide5.xml")
		expect(copy?.shapes.map(shape => shape.id)).toEqual(first.shapes.map(shape => shape.id))
		expect(copy?.shapes[1]?.src).toEqual(first.shapes[1]?.src)
		expect(copy?.notes).not.toBe(first.notes)
		expect(deck.nodes.get(copy?.notes as never)?.part).toBe("/ppt/notesSlides/notesSlide2.xml")
		expect(deck.sections[0]?.slides).toContain(copy?.ref)
		harness.close()
	})

	it("moving slides keeps each section a run of slides, and undo restores the order and the sections", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const order = [...deck.slides]
		const sections = JSON.stringify(deck.sections)

		await harness.command({ family: "slide", kind: "move", slides: [order[0] as never], to: 3 })
		expect(deck.slides).toEqual([order[1], order[2], order[3], order[0]])
		expect(deck.sections.map(section => section.slides)).toEqual([[order[1]], [order[2], order[3], order[0]]])
		await harness.undo()
		expect(deck.slides).toEqual(order)
		expect(JSON.stringify(deck.sections)).toBe(sections)
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		harness.close()
	})

	it("group and ungroup keep every child where it was on the slide, and undo puts the tree back", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)
		const tree = JSON.stringify(slide.shapes.map(shape => [shape.id, shape.children?.map(child => child.id)]))

		expect(await harness.command({ family: "shape", kind: "group", slide: slide.ref, shapes: [3, 4] })).toMatchObject({ ok: true })

		const group = slide.shapes.find(shape => shape.kind === "grpSp" && shape.children?.some(child => child.id === 3))

		expect(group?.xfrm).toMatchObject({ x: 100, y: 100, cx: 2700, cy: 600, chX: 100, chY: 100, chCx: 2700, chCy: 600 })
		await harness.undo()
		expect(JSON.stringify(slide.shapes.map(shape => [shape.id, shape.children?.map(child => child.id)]))).toBe(tree)

		// The fixture's group scales its child space by 2: ungrouped, the children are drawn where they were.
		expect(await harness.command({ family: "shape", kind: "ungroup", slide: slide.ref, group: 6 })).toMatchObject({ ok: true })
		expect(shapeById(slide.shapes, 7)?.xfrm).toMatchObject({ x: 5000, y: 5000, cx: 1000, cy: 1000 })
		expect(shapeById(slide.shapes, 8)?.xfrm).toMatchObject({ x: 6000, y: 5000, cx: 1000, cy: 1000 })
		await harness.undo()
		expect(JSON.stringify(slide.shapes.map(shape => [shape.id, shape.children?.map(child => child.id)]))).toBe(tree)
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		harness.close()
	})

	it("align and distribute move by rotated bounds and undo to the boxes they had", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)

		await harness.command({ family: "shape", kind: "align", slide: slide.ref, shapes: [3, 4, 5], edge: "top", relativeTo: "selection" })
		expect([3, 4, 5].map(id => shapeById(slide.shapes, id)?.xfrm?.y)).toEqual([100, 100, 100])
		await harness.undo()
		await harness.command({
			family: "shape",
			kind: "distribute",
			slide: slide.ref,
			shapes: [3, 4, 5],
			axis: "horizontal",
			relativeTo: "selection"
		})

		const xs = [3, 4, 5].map(id => shapeById(slide.shapes, id)?.xfrm)
		const gaps = [(xs[1]?.x ?? 0) - ((xs[0]?.x ?? 0) + (xs[0]?.cx ?? 0)), (xs[2]?.x ?? 0) - ((xs[1]?.x ?? 0) + (xs[1]?.cx ?? 0))]

		expect(Math.abs((gaps[0] ?? 0) - (gaps[1] ?? 0))).toBeLessThanOrEqual(1)
		await harness.undo()
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		harness.close()
	})

	it("a view-only deck refuses every command", async () => {
		const harness = await editHarness(editDeck())

		harness.session.deck.gate.push("signed")
		expect(
			await harness.command({ family: "slide", kind: "hide", slides: [harness.session.deck.slides[0] as never], hidden: true })
		).toEqual({
			ok: false,
			refusal: "viewOnly"
		})
		harness.close()
	})
})
