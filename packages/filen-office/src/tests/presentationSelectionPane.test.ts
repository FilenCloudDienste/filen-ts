import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import {
	nameOp,
	outlineIds,
	outlineLevel,
	outlineRows,
	reorderOp,
	visibilityAllOp,
	visibilityOp
} from "../core/presentation/edit/commands/selectionPane"
import { slideRef, type SlideNode, type SlideRef } from "../core/presentation/model"
import { slideOutline, type OutlineShape } from "../core/presentation/outline"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { outlineCapability } from "../dom/presentation/engine/outline"
import { renderSlideFor } from "../dom/presentation/engine/view"
import type { CallContext } from "../dom/presentation/engine"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { editDeck, shapeById } from "./presentationEditFixtures"

// The Selection Pane: its list (front-most first, groups with their members), Show All / Hide All and the eye
// (cNvPr hidden; ODF draw:display), renaming (cNvPr name; ODF draw:name) and reordering by drag (z-order to an index),
// each one undo step, written by a save and read back.

const slide = slideRef(256)

const shape = (id: number, extra: Partial<OutlineShape> = {}): OutlineShape => ({
	id,
	name: `S${String(id)}`,
	hidden: false,
	role: "shape",
	...extra
})

const OUTLINE: readonly OutlineShape[] = [
	shape(2, { role: "placeholder" }),
	shape(3, { hidden: true }),
	shape(6, { role: "group", children: [shape(7), shape(8, { lock: "alternateContent" })] }),
	shape(9)
]

describe("the Selection Pane's list", () => {
	it("lists the front-most first, members indented under their group, a collapsed group's left out", () => {
		expect(outlineRows(OUTLINE, new Set()).map(row => [row.shape.id, row.depth, row.parent, row.index])).toEqual([
			[9, 0, 0, 3],
			[6, 0, 0, 2],
			[8, 1, 6, 1],
			[7, 1, 6, 0],
			[3, 0, 0, 1],
			[2, 0, 0, 0]
		])
		expect(outlineRows(OUTLINE, new Set([6])).map(row => row.shape.id)).toEqual([9, 6, 3, 2])
		expect(outlineIds(OUTLINE)).toEqual([2, 3, 6, 7, 8, 9])
		expect(outlineLevel(OUTLINE, 6)?.map(each => each.id)).toEqual([7, 8])
		expect(outlineLevel(OUTLINE, 9)).toEqual([])
		expect(outlineLevel(OUTLINE, 99)).toBeUndefined()
	})

	it("Show All and Hide All change every object not as asked yet, members too, never a locked one", () => {
		expect(visibilityAllOp(slide, OUTLINE, false)).toEqual({ family: "shape", kind: "setHidden", slide, shapes: [3], hidden: false })
		expect(visibilityAllOp(slide, OUTLINE, true)).toEqual({
			family: "shape",
			kind: "setHidden",
			slide,
			shapes: [2, 6, 7, 9],
			hidden: true
		})
		expect(visibilityAllOp(slide, [shape(4, { hidden: true })], true)).toBeUndefined()
		expect(visibilityOp(slide, [4, 4], true)).toEqual({ family: "shape", kind: "setHidden", slide, shapes: [4], hidden: true })
		expect(visibilityOp(slide, [], true)).toBeUndefined()
	})

	it("a rename is trimmed and cleaned; an empty or unchanged name is no op", () => {
		const target = { slide, id: 4 }

		expect(nameOp(target, "  Logo\u0001 ", "Box B")).toEqual({ family: "shape", kind: "setName", target, name: "Logo" })
		expect(nameOp(target, "   ", "Box B")).toBeUndefined()
		expect(nameOp(target, "Box B ", "Box B")).toBeUndefined()
	})

	it("a drop above a row puts the dragged objects in front of it, below it behind it", () => {
		const level = [shape(2), shape(3), shape(4), shape(5)]

		// Shown top to bottom 5 4 3 2: 2 dropped above 4 goes between 5 and 4 (back to front 3 4 2 5).
		expect(reorderOp(slide, level, [2], 4, "above")).toEqual({ family: "shape", kind: "zOrder", slide, shapes: [2], to: 2 })
		expect(reorderOp(slide, level, [5], 3, "below")).toEqual({ family: "shape", kind: "zOrder", slide, shapes: [5], to: 1 })
		// Where they already are, onto a dragged row, or rows of another level: nothing.
		expect(reorderOp(slide, level, [2], 3, "below")).toBeUndefined()
		expect(reorderOp(slide, level, [2, 3], 3, "above")).toBeUndefined()
		expect(reorderOp(slide, level, [7], 3, "above")).toBeUndefined()
	})
})

async function pptxSlide(d: Awaited<ReturnType<typeof driveSession>>, index = 0): Promise<SlideNode> {
	const ref = d.session.deck.slides[index] as SlideRef

	return (pptxParts(d.session.deck) ?? (undefined as never)).slide(ref)
}

const slideXml = (bytes: Uint8Array | undefined): string =>
	strFromU8(
		unzipSync(bytes ?? new Uint8Array(), { filter: file => file.name === "ppt/slides/slide1.xml" })[
			"ppt/slides/slide1.xml"
		] as Uint8Array
	)

const ids = (node: SlideNode): number[] => node.shapes.map(each => each.id)

describe("the Selection Pane's commands in a .pptx", () => {
	it("outlines the slide's own objects, hidden ones included, groups with their members", async () => {
		const d = await driveSession(editDeck(), "pptx")
		const node = await pptxSlide(d)
		const outline = await outlineCapability.outline(d.context as CallContext, node.ref)

		expect(outline.slide).toBe(node.ref)
		expect(outline.revision).toBe(node.revision)
		expect(outline.shapes.map(each => [each.id, each.name, each.role])).toEqual([
			[2, "Title 1", "placeholder"],
			[3, "Box A", "shape"],
			[4, "Box B", "shape"],
			[5, "Box C", "shape"],
			[6, "Group 5", "group"],
			[9, "Jump", "shape"]
		])
		expect(outline.shapes[4]?.children?.map(each => each.name)).toEqual(["Inner 1", "Inner 2"])
		expect(outline).toEqual(slideOutline(node))
		await expect(outlineCapability.outline(d.context as CallContext, slideRef(9999))).rejects.toMatchObject({ reason: "notFound" })
	})

	it("hides objects in one step: not drawn, undone and redone, written as hidden and read back", async () => {
		const d = await driveSession(editDeck(), "pptx")
		const node = await pptxSlide(d)
		const drawn = async (): Promise<Set<number>> => {
			const render = await renderSlideFor(d.context as CallContext, node.ref)

			return new Set(
				render.layers.flatMap(layer => (layer.box === undefined ? [] : [layer.box.id, ...(layer.box.members ?? []).map(m => m.id)]))
			)
		}

		expect((await drawn()).has(3)).toBe(true)
		expect((await d.command({ family: "shape", kind: "setHidden", slide: node.ref, shapes: [3, 7], hidden: true })).ok).toBe(true)
		expect(shapeById(node.shapes, 3)?.hidden).toBe(true)
		expect(shapeById(node.shapes, 7)?.hidden).toBe(true)
		expect(await drawn()).not.toContain(3)
		expect(await drawn()).not.toContain(7)
		expect((await outlineCapability.outline(d.context as CallContext, node.ref)).shapes[1]).toMatchObject({ id: 3, hidden: true })

		expect((await d.undo()).ok).toBe(true)
		expect(shapeById(node.shapes, 3)?.hidden).toBe(false)
		expect(shapeById(node.shapes, 7)?.hidden).toBe(false)
		expect((await d.redo()).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result).toMatchObject({ kind: "written" })

		const xml = slideXml(saved.bytes)

		expect(xml).toContain('<p:cNvPr id="3" name="Box A" hidden="1"/>')
		expect(xml).toContain('<p:cNvPr id="7" name="Inner 1" hidden="1"/>')
		expect(xml).not.toContain('name="Box B" hidden')

		const again = await driveSession(saved.bytes ?? new Uint8Array(), "pptx")
		const read = await pptxSlide(again)

		expect(shapeById(read.shapes, 3)?.hidden).toBe(true)
		expect(shapeById(read.shapes, 7)?.hidden).toBe(true)
		expect(shapeById(read.shapes, 4)?.hidden).toBe(false)

		// Shown again and saved: the attribute is gone.
		expect((await again.command({ family: "shape", kind: "setHidden", slide: read.ref, shapes: [3, 7], hidden: false })).ok).toBe(true)
		expect(slideXml((await again.save()).bytes)).toContain('<p:cNvPr id="3" name="Box A"/>')
	})

	it("an object already as asked is no step; an unknown one is refused", async () => {
		const d = await driveSession(editDeck(), "pptx")
		const node = await pptxSlide(d)
		const before = node.revision

		expect((await d.command({ family: "shape", kind: "setHidden", slide: node.ref, shapes: [4], hidden: false })).ok).toBe(true)
		expect(node.revision).toBe(before)
		expect(await d.command({ family: "shape", kind: "setHidden", slide: node.ref, shapes: [404], hidden: true })).toMatchObject({
			ok: false,
			refusal: "notFound"
		})
	})

	it("renames an object, a group's member too, and writes the name back", async () => {
		const d = await driveSession(editDeck(), "pptx")
		const node = await pptxSlide(d)

		expect((await d.command({ family: "shape", kind: "setName", target: { slide: node.ref, id: 4 }, name: "Logo" })).ok).toBe(true)
		expect((await d.command({ family: "shape", kind: "setName", target: { slide: node.ref, id: 8 }, name: "Right & left" })).ok).toBe(
			true
		)
		expect(shapeById(node.shapes, 4)?.name).toBe("Logo")
		expect((await d.undo()).ok).toBe(true)
		expect(shapeById(node.shapes, 8)?.name).toBe("Inner 2")
		expect((await d.redo()).ok).toBe(true)

		for (const name of ["", "  ", "bad\u0001"])
			expect(await d.command({ family: "shape", kind: "setName", target: { slide: node.ref, id: 4 }, name })).toMatchObject({
				ok: false,
				refusal: "malformed"
			})

		const saved = await d.save()
		const xml = slideXml(saved.bytes)

		expect(xml).toContain('<p:cNvPr id="4" name="Logo"/>')
		expect(xml).toContain('<p:cNvPr id="8" name="Right &amp; left"/>')

		const read = await pptxSlide(await driveSession(saved.bytes ?? new Uint8Array(), "pptx"))

		expect(shapeById(read.shapes, 8)?.name).toBe("Right & left")
	})

	it("a drag's z-order puts the objects at an index among the others, one undo step, and saves that order", async () => {
		const d = await driveSession(editDeck(), "pptx")
		const node = await pptxSlide(d)

		expect(ids(node)).toEqual([2, 3, 4, 5, 6, 9])
		expect((await d.command({ family: "shape", kind: "zOrder", slide: node.ref, shapes: [3, 4], to: 3 })).ok).toBe(true)
		expect(ids(node)).toEqual([2, 5, 6, 3, 4, 9])
		expect((await d.undo()).ok).toBe(true)
		expect(ids(node)).toEqual([2, 3, 4, 5, 6, 9])
		expect((await d.redo()).ok).toBe(true)

		// Where they already are: no step.
		const revision = node.revision

		expect((await d.command({ family: "shape", kind: "zOrder", slide: node.ref, shapes: [3, 4], to: 3 })).ok).toBe(true)
		expect(node.revision).toBe(revision)
		// Within a group, past the end: the front of its level.
		expect((await d.command({ family: "shape", kind: "zOrder", slide: node.ref, shapes: [7], to: 99 })).ok).toBe(true)
		expect(shapeById(node.shapes, 6)?.children?.map(each => each.id)).toEqual([8, 7])
		expect(await d.command({ family: "shape", kind: "zOrder", slide: node.ref, shapes: [3, 7], to: 0 })).toMatchObject({
			ok: false,
			refusal: "unsupported"
		})
		expect(await d.command({ family: "shape", kind: "zOrder", slide: node.ref, shapes: [3], to: 1.5 })).toMatchObject({
			ok: false,
			refusal: "malformed"
		})

		const saved = await d.save()

		expect(saved.result).toMatchObject({ kind: "written" })

		const read = await pptxSlide(await driveSession(saved.bytes ?? new Uint8Array(), "pptx"))

		expect(ids(read)).toEqual([2, 5, 6, 3, 4, 9])
		expect(shapeById(read.shapes, 6)?.children?.map(each => each.id)).toEqual([8, 7])
	})
})

describe("the Selection Pane's commands in an .odp", () => {
	const PAGE =
		'<draw:page draw:name="a" draw:master-page-name="M">' +
		'<draw:custom-shape draw:name="Box" svg:x="2cm" svg:y="2cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>' +
		'<draw:custom-shape draw:name="Other" svg:x="8cm" svg:y="2cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>' +
		"</draw:page>"

	it("writes a hidden object as draw:display none and a new name as draw:name, and reads them back", async () => {
		const d = await driveSession(odpBytes({ body: PAGE }), "odp")
		const deck = d.session.deck
		const node = await (odpParts(deck) ?? (undefined as never)).slide(deck.slides[0] as SlideRef)
		const [box, other] = node.shapes

		if (box === undefined || other === undefined) throw new Error("fixture")

		expect((await d.command({ family: "shape", kind: "setHidden", slide: node.ref, shapes: [box.id], hidden: true })).ok).toBe(true)
		expect((await d.command({ family: "shape", kind: "setName", target: { slide: node.ref, id: other.id }, name: "Renamed" })).ok).toBe(
			true
		)

		const saved = await d.save()

		expect(saved.result).toMatchObject({ kind: "written" })

		const content = strFromU8(
			unzipSync(saved.bytes ?? new Uint8Array(), { filter: file => file.name === "content.xml" })["content.xml"] as Uint8Array
		)

		expect(content).toMatch(
			/<draw:custom-shape[^>]*draw:name="Box"[^>]*draw:display="none"|<draw:custom-shape[^>]*draw:display="none"[^>]*draw:name="Box"/u
		)
		expect(content).toContain('draw:name="Renamed"')

		const again = await driveSession(saved.bytes ?? new Uint8Array(), "odp")
		const read = await (odpParts(again.session.deck) ?? (undefined as never)).slide(again.session.deck.slides[0] as SlideRef)

		expect(read.shapes.map(each => [each.name, each.hidden])).toEqual([
			["Box", true],
			["Renamed", false]
		])
	})
})
