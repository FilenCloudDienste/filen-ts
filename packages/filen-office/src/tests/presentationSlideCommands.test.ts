import { describe, expect, it } from "vitest"
import {
	addSectionOp,
	addSlideOp,
	deleteSlidesOp,
	duplicateSlideOps,
	moveSlidesOp,
	newSlideLayout,
	nudgeSlidesOp,
	removeSectionOp,
	renameSectionOp,
	resetSlideOps,
	setLayoutOps,
	slideListRows,
	toggleHiddenOp,
	type SlideLayoutChoice
} from "../core/presentation/edit/commands/slide"
import { slideRef, type Section, type SlideRef } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { emitPptx } from "../core/pptx/write/emit"
import { editDeck, editHarness, shapeById } from "./presentationEditFixtures"
import { saveEdits } from "./pptxWriteFixtures"
import { budget, cpuMs } from "./timing"

const refs = (...values: number[]): SlideRef[] => values.map(value => slideRef(value))
const order = refs(1, 2, 3, 4, 5)

describe("slide commands", () => {
	it("a new slide follows the current slide's layout, and after a title slide takes its master's Title and Content", () => {
		const layouts: SlideLayoutChoice[] = [
			{ ref: slideRef(10), master: slideRef(9), type: "title", name: "Title Slide" },
			{ ref: slideRef(11), master: slideRef(9), type: "obj", name: "Title and Content" },
			{ ref: slideRef(12), master: slideRef(9), type: "twoObj" },
			{ ref: slideRef(21), master: slideRef(20), type: "title" },
			{ ref: slideRef(22), master: slideRef(20), type: "blank" }
		]

		expect(newSlideLayout(layouts, slideRef(12))).toBe(slideRef(12))
		expect(newSlideLayout(layouts, slideRef(10))).toBe(slideRef(11))
		// A master without Title and Content: its first layout that is not a title slide.
		expect(newSlideLayout(layouts, slideRef(21))).toBe(slideRef(22))
		// No slide to follow: the first master's.
		expect(newSlideLayout(layouts, undefined)).toBe(slideRef(11))
		expect(newSlideLayout([], undefined)).toBeUndefined()
	})

	it("duplicates the selection in deck order right after its last slide, as one step", () => {
		expect(duplicateSlideOps(order, refs(4, 2))).toEqual([
			{
				family: "batch",
				kind: "batch",
				ops: [
					{ family: "slide", kind: "duplicate", slide: slideRef(2), at: 4 },
					{ family: "slide", kind: "duplicate", slide: slideRef(4), at: 5 }
				]
			}
		])
		expect(duplicateSlideOps(order, refs(3))).toEqual([{ family: "slide", kind: "duplicate", slide: slideRef(3), at: 3 }])
		expect(duplicateSlideOps(order, [])).toEqual([])
	})

	it("moves a selection to stand before a drop index counted in the current list", () => {
		// Drop 2 and 3 before slide 5 (index 4).
		expect(moveSlidesOp(order, refs(2, 3), 4)).toEqual({ family: "slide", kind: "move", slides: refs(2, 3), to: 2 })
		// Dropped where they already are: nothing to do.
		expect(moveSlidesOp(order, refs(2, 3), 1)).toBeUndefined()
		expect(moveSlidesOp(order, refs(2, 3), 3)).toBeUndefined()
		expect(moveSlidesOp(order, refs(1), 5)).toEqual({ family: "slide", kind: "move", slides: refs(1), to: 4 })
	})

	it("nudges a block one place past its neighbour, or to either end", () => {
		expect(nudgeSlidesOp(order, refs(3, 4), -1)).toEqual({ family: "slide", kind: "move", slides: refs(3, 4), to: 1 })
		expect(nudgeSlidesOp(order, refs(3, 4), 1)).toEqual({ family: "slide", kind: "move", slides: refs(3, 4), to: 3 })
		expect(nudgeSlidesOp(order, refs(1), -1)).toBeUndefined()
		expect(nudgeSlidesOp(order, refs(5), 1)).toBeUndefined()
		expect(nudgeSlidesOp(order, refs(4), "first")).toEqual({ family: "slide", kind: "move", slides: refs(4), to: 0 })
		expect(nudgeSlidesOp(order, refs(2), "last")).toEqual({ family: "slide", kind: "move", slides: refs(2), to: 4 })
	})

	it("hides a selection while any of it is shown, and shows it when all is hidden", () => {
		const slides = [
			{ ref: slideRef(1), hidden: true },
			{ ref: slideRef(2), hidden: false },
			{ ref: slideRef(3), hidden: true }
		]

		expect(toggleHiddenOp(slides, refs(1, 2))).toEqual({ family: "slide", kind: "hide", slides: refs(1, 2), hidden: true })
		expect(toggleHiddenOp(slides, refs(1, 3))).toEqual({ family: "slide", kind: "hide", slides: refs(1, 3), hidden: false })
		expect(toggleHiddenOp(slides, [])).toBeUndefined()
	})

	it("adds a section at a slide, splitting the section it was in, and names a first section when there was none", () => {
		const id = { id: "{N}", name: "New" }

		expect(addSectionOp(order, [], 2, id, "Default Section", "{D}")).toEqual({
			family: "slide",
			kind: "setSections",
			sections: [
				{ id: "{D}", name: "Default Section", slides: refs(1, 2) },
				{ id: "{N}", name: "New", slides: refs(3, 4, 5) }
			]
		})

		const sections: Section[] = [
			{ id: "a", name: "A", slides: refs(1, 2, 3) },
			{ id: "b", name: "B", slides: refs(4, 5) }
		]

		expect(addSectionOp(order, sections, 1, id, "", "")).toMatchObject({
			sections: [
				{ id: "a", slides: refs(1) },
				{ id: "{N}", slides: refs(2, 3) },
				{ id: "b", slides: refs(4, 5) }
			]
		})
		// At a section's first slide: the new section takes its whole run, and the old one stays, empty.
		expect(addSectionOp(order, sections, 3, id, "", "")).toMatchObject({
			sections: [
				{ id: "a", slides: refs(1, 2, 3) },
				{ id: "b", name: "B", slides: [] },
				{ id: "{N}", slides: refs(4, 5) }
			]
		})
		// At the first slide of a deck without sections: no empty default section before it.
		expect(addSectionOp(order, [], 0, id, "Default Section", "{D}")).toEqual({
			family: "slide",
			kind: "setSections",
			sections: [{ id: "{N}", name: "New", slides: refs(1, 2, 3, 4, 5) }]
		})
	})

	it("renames and removes sections, the removed one's slides joining the section before it", () => {
		const sections: Section[] = [
			{ id: "a", name: "A", slides: refs(1, 2) },
			{ id: "b", name: "B", slides: refs(3) },
			{ id: "c", name: "C", slides: refs(4, 5) }
		]

		expect(renameSectionOp(sections, "b", "  Middle ")).toMatchObject({ sections: [{ name: "A" }, { name: "Middle" }, { name: "C" }] })
		expect(renameSectionOp(sections, "b", "B")).toBeUndefined()
		expect(renameSectionOp(sections, "b", " ")).toBeUndefined()
		expect(removeSectionOp(order, sections, "b")).toMatchObject({
			sections: [
				{ id: "a", slides: refs(1, 2, 3) },
				{ id: "c", slides: refs(4, 5) }
			]
		})
		expect(removeSectionOp(order, sections, "a")).toMatchObject({
			sections: [
				{ id: "b", slides: refs(1, 2, 3) },
				{ id: "c", slides: refs(4, 5) }
			]
		})
		expect(removeSectionOp(refs(1), [{ id: "a", name: "A", slides: refs(1) }], "a")).toEqual({
			family: "slide",
			kind: "setSections",
			sections: []
		})
	})

	it("lists a section header before each section's slides, slides before the first section joining it", () => {
		expect(slideListRows(refs(1, 2), [])).toEqual([
			{ kind: "slide", index: 0 },
			{ kind: "slide", index: 1 }
		])
		expect(
			slideListRows(order, [
				{ id: "a", name: "A", slides: refs(2) },
				{ id: "e", name: "Empty", slides: [] },
				{ id: "b", name: "B", slides: refs(3, 4, 5) }
			])
		).toEqual([
			{ kind: "section", section: 0, first: 0, count: 2 },
			{ kind: "slide", index: 0 },
			{ kind: "slide", index: 1 },
			{ kind: "section", section: 1, first: 2, count: 0 },
			{ kind: "section", section: 2, first: 2, count: 3 },
			{ kind: "slide", index: 2 },
			{ kind: "slide", index: 3 },
			{ kind: "slide", index: 4 }
		])
	})

	it("lists 10,000 slides in 100 sections in linear time", () => {
		const many = Array.from({ length: 10_000 }, (_, index) => slideRef(index + 1))
		const sections = Array.from({ length: 100 }, (_, index) => ({
			id: String(index),
			name: String(index),
			slides: many.slice(index * 100, index * 100 + 100)
		}))
		let least = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const started = cpuMs()

			expect(slideListRows(many, sections)).toHaveLength(10_100)
			least = Math.min(least, cpuMs() - started)
		}

		// A quadratic walk takes seconds here.
		expect(least).toBeLessThan(budget(30))
	})
})

// Each command applied to a real deck through the edit capability, then undone.
describe("slide commands on a deck", () => {
	it("adds a slide after the current one on the layout it follows, and undo removes it", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const before = [...deck.slides]
		const first = await harness.slide(0)
		const layouts = deck.layouts.map(ref => {
			const node = deck.nodes.get(ref)

			return { ref, master: node?.parent ?? ref, ...(node?.layoutType === undefined ? {} : { type: node.layoutType }) }
		})
		const layout = newSlideLayout(layouts, first.parent)

		expect(layout).toBe(first.parent)
		expect(await harness.command(addSlideOp(1, layout ?? first.ref))).toMatchObject({ ok: true, dirty: true })
		expect(deck.slides).toHaveLength(5)
		expect(deck.slides.slice(0, 1).concat(deck.slides.slice(2))).toEqual(before)

		const added = await harness.slide(1)

		expect(added.parent).toBe(first.parent)
		// Its placeholders are the layout's, empty.
		expect(added.shapes.map(shape => shape.ph?.type)).toEqual(["title", "obj"])
		// It joins the section of the slide before it.
		expect(deck.sections[0]?.slides).toEqual([before[0], added.ref, before[1]])
		expect(await harness.undo()).toMatchObject({ ok: true, dirty: false })
		expect(deck.slides).toEqual(before)
		harness.close()
	})

	it("duplicates two slides after the last of them, and one undo takes both back", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const before = [...deck.slides]

		for (const op of duplicateSlideOps(
			deck.slides,
			[before[2], before[0]].filter(ref => ref !== undefined)
		)) {
			expect(await harness.command(op)).toMatchObject({ ok: true })
		}

		expect(deck.slides.slice(0, 3)).toEqual(before.slice(0, 3))
		expect(deck.slides.slice(5)).toEqual(before.slice(3))

		const copyOfFirst = await harness.slide(3)

		expect(shapeById(copyOfFirst.shapes, 2)?.text?.paragraphs[0]?.runs[0]).toMatchObject({ text: "Title" })
		await harness.undo()
		expect(deck.slides).toEqual(before)
		expect(await harness.redo()).toMatchObject({ ok: true })
		expect(deck.slides).toHaveLength(before.length + 2)
		await harness.undo()
		expect(deck.slides).toEqual(before)
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		harness.close()
	})

	it("deletes a selection, moves and hides slides, and undo restores each", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const before = [...deck.slides]
		const [a, b, c, d] = before

		if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("four slides")

		expect(await harness.command(deleteSlidesOp(deck.slides, [c, b]) ?? fail())).toMatchObject({ ok: true })
		expect(deck.slides).toEqual([a, d])
		await harness.undo()
		expect(deck.slides).toEqual(before)

		expect(await harness.command(moveSlidesOp(deck.slides, [a], 3) ?? fail())).toMatchObject({ ok: true })
		expect(deck.slides).toEqual([b, c, a, d])
		expect(await harness.command(nudgeSlidesOp(deck.slides, [a], "last") ?? fail())).toMatchObject({ ok: true })
		expect(deck.slides).toEqual([b, c, d, a])
		await harness.undo()
		await harness.undo()
		expect(deck.slides).toEqual(before)

		await harness.slide(1)
		expect(await harness.command(toggleHiddenOp([{ ref: b, hidden: false }], [b]) ?? fail())).toMatchObject({ ok: true })
		expect((await harness.slide(1)).hidden).toBe(true)
		await harness.undo()
		expect((await harness.slide(1)).hidden).toBe(false)
		harness.close()
	})

	it("changes a slide's layout and resets it, undo restoring both", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const slide = await harness.slide(1)
		const original = slide.parent
		const other = deck.layouts.find(ref => ref !== original)

		if (other === undefined || original === undefined) throw new Error("two layouts")

		for (const op of setLayoutOps(deck.slides, [slide.ref], other)) expect(await harness.command(op)).toMatchObject({ ok: true })
		expect(deck.nodes.get(slide.ref)?.parent).toBe(other)

		for (const op of resetSlideOps(deck.slides, [slide.ref])) expect(await harness.command(op)).toMatchObject({ ok: true })
		await harness.undo()
		await harness.undo()
		expect(deck.nodes.get(slide.ref)?.parent).toBe(original)
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		harness.close()
	})

	it("adds, renames and removes a section", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const before = structuredClone(deck.sections)

		expect(
			await harness.command(addSectionOp(deck.slides, deck.sections, 3, { id: "{N}", name: "Last" }, "Default", "{D}") ?? fail())
		).toMatchObject({ ok: true, dirty: true })
		expect(deck.sections.map(section => [section.name, section.slides.length])).toEqual([
			["First", 2],
			["Rest", 1],
			["Last", 1]
		])
		expect(await harness.command(renameSectionOp(deck.sections, "{N}", "End") ?? fail())).toMatchObject({ ok: true })
		expect(await harness.command(removeSectionOp(deck.slides, deck.sections, "{N}") ?? fail())).toMatchObject({ ok: true })
		expect(deck.sections).toEqual(before)
		await harness.undo()
		await harness.undo()
		await harness.undo()
		expect(deck.sections).toEqual(before)
		expect(sessionEdits(harness.session).history.dirty).toBe(false)
		harness.close()
	})
})

describe("sections across a save", () => {
	it("a section left empty by Add Section at its first slide is saved with its name and read back", async () => {
		const harness = await editHarness(editDeck(), { emit: emitPptx } as never)
		const deck = harness.session.deck
		const at = deck.slides.indexOf(deck.sections[1]?.slides[0] ?? fail())

		expect(
			await harness.command(addSectionOp(deck.slides, deck.sections, at, { id: "{N}", name: "Added" }, "Default", "{D}") ?? fail())
		).toMatchObject({ ok: true })

		const saved = await saveEdits(harness, sessionEdits(harness.session).history.revision)

		harness.close()

		const reopened = await editHarness(saved)

		expect(reopened.session.deck.sections.map(section => [section.name, section.slides.length])).toEqual([
			["First", 2],
			["Rest", 0],
			["Added", 2]
		])
		reopened.close()
	})
})

function fail(): never {
	throw new Error("expected an op")
}
