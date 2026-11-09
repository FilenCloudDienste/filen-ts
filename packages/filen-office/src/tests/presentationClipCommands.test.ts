import { describe, expect, it } from "vitest"
import {
	clipHtml,
	clipIdOf,
	clipPartNames,
	clipPlainText,
	PASTE_STEP,
	pasteOffset,
	pasteShapesOp,
	pasteSlidesOps,
	shapeText,
	type ShapeClip,
	type SlideClip
} from "../core/presentation/edit/clip"
import { slideRef, type Xfrm } from "../core/presentation/model"

// The page's half of Cut, Copy and Paste: where a paste lands, what it carries, and what other apps are given.

function box(x: number, y: number, cx = 1000, cy = 500): Xfrm {
	return { x, y, cx, cy, rot: 0, flipH: false, flipV: false }
}

const raw = new TextEncoder().encode("<p:sp/>")

function shapeClip(overrides: Partial<ShapeClip> = {}): ShapeClip {
	return {
		kind: "shapes",
		format: "pptx",
		slide: slideRef(1),
		shapes: [{ raw }],
		boxes: [box(100, 100)],
		relationships: [],
		text: [["One"]],
		...overrides
	}
}

describe("paste position", () => {
	it("keeps the copied place where no shape of the same box sits (another slide, after a cut)", () => {
		expect(pasteOffset(shapeClip(), [box(5000, 5000)])).toEqual({ dx: 0, dy: 0 })
	})

	it("steps down and right past each copy already there, as pastes in a row cascade", () => {
		expect(pasteOffset(shapeClip(), [box(100, 100)])).toEqual({ dx: PASTE_STEP, dy: PASTE_STEP })
		expect(pasteOffset(shapeClip(), [box(100, 100), box(100 + PASTE_STEP, 100 + PASTE_STEP)])).toEqual({
			dx: 2 * PASTE_STEP,
			dy: 2 * PASTE_STEP
		})
	})

	it("does not step for a box of another size at the same place", () => {
		expect(pasteOffset(shapeClip(), [box(100, 100, 999)])).toEqual({ dx: 0, dy: 0 })
	})
})

describe("paste of shapes", () => {
	const jump = {
		id: "rId3",
		type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
		target: "ppt/slides/slide1.xml",
		jump: true as const
	}
	const image = {
		id: "rId2",
		type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
		target: "ppt/media/image1.png"
	}

	it("pastes within its deck naming the deck's parts", () => {
		const op = pasteShapesOp(shapeClip({ relationships: [image, jump] }), {
			slide: slideRef(2),
			boxes: [],
			sameDeck: true,
			format: "pptx"
		})

		expect(op).toMatchObject({ kind: "paste", slide: slideRef(2), dx: 0, dy: 0, relationships: [{ id: "rId2" }, { id: "rId3" }] })
	})

	it("brings another deck's parts' bytes along, and refuses without them", () => {
		const clip = shapeClip({ relationships: [image] })
		const bytes = new Uint8Array([1])

		expect(clipPartNames(clip)).toEqual(["ppt/media/image1.png"])
		expect(pasteShapesOp(clip, { slide: slideRef(2), boxes: [], sameDeck: false, format: "pptx" })).toBe("notFound")
		expect(
			pasteShapesOp(clip, {
				slide: slideRef(2),
				boxes: [],
				sameDeck: false,
				format: "pptx",
				parts: new Map([["ppt/media/image1.png", { bytes, contentType: "image/png" }]])
			})
		).toMatchObject({ relationships: [{ id: "rId2", bytes, contentType: "image/png" }] })
	})

	it("refuses into another deck a link to one of the clip's slides, ODP markup, and another format", () => {
		const target = { slide: slideRef(2), boxes: [], sameDeck: false, format: "pptx" as const, parts: new Map() }

		expect(pasteShapesOp(shapeClip({ relationships: [jump] }), target)).toBe("unsupported")
		expect(pasteShapesOp(shapeClip({ format: "odp" }), target)).toBe("unsupported")
		expect(pasteShapesOp(shapeClip(), { ...target, format: "odp" })).toBe("unsupported")
	})
})

describe("paste of slides", () => {
	const [one, two, three] = [slideRef(1), slideRef(2), slideRef(3)]

	it("duplicates copied slides after the current one, in their order, as one step", () => {
		const clip: SlideClip = { kind: "slides", format: "pptx", slides: [one, three], text: [] }

		expect(pasteSlidesOps(clip, [one, two, three], 1, true)).toEqual([
			{
				family: "batch",
				kind: "batch",
				ops: [
					{ family: "slide", kind: "duplicate", slide: one, at: 2 },
					{ family: "slide", kind: "duplicate", slide: three, at: 3 }
				]
			}
		])
	})

	it("puts a cut slide back from what the cut held, and refuses one neither in the deck nor held", () => {
		const parts = [{ name: "/ppt/slides/slide2.xml", contentType: "application/xml", bytes: new Uint8Array(0) }]
		const held: SlideClip = { kind: "slides", format: "pptx", slides: [two], held: [{ ref: two, parts }], text: [] }

		expect(pasteSlidesOps(held, [one, three], -1, true)).toEqual([
			{ family: "slide", kind: "restore", slides: [{ ref: two, at: 0, parts }] }
		])
		expect(pasteSlidesOps({ ...held, held: [] }, [one, three], 0, true)).toBe("notFound")
		expect(pasteSlidesOps(held, [one, three], 0, false)).toBe("unsupported")
	})
})

describe("what other apps are given", () => {
	it("writes the shapes' paragraphs as text and as HTML naming the clip", () => {
		const text = [["Title", "Line\nbreak"], ["<b>&"]]
		const html = clipHtml("id-1", text)

		expect(clipPlainText(text)).toBe("Title\r\nLine\r\nbreak\r\n<b>&")
		expect(html).toContain("&lt;b&gt;&amp;")
		expect(html).toContain("Line<br>break")
		expect(clipIdOf(html)).toBe("id-1")
		expect(clipIdOf("<p>other</p>")).toBeUndefined()
	})

	it("reads a shape's text from its body, a table's cells and a group's children", () => {
		const para = (text: string) => ({ pPr: {}, runs: [{ kind: "r" as const, text, rPr: {} }] })

		expect(
			shapeText({
				id: 1,
				name: "Group",
				hidden: false,
				kind: "grpSp",
				children: [{ id: 2, name: "A", hidden: false, kind: "sp", text: { bodyPr: {}, paragraphs: [para("A"), para("B")] } }]
			})
		).toEqual(["A", "B"])
	})
})
