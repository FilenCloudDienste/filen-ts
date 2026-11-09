import { afterEach, describe, expect, it, vi } from "vitest"
import { insertTextBoxOp, slideRef, type ImportedSlide, type ShapeClip, type SlideClip } from "@filen/office/core/presentation"
import type { ClipSlidesResult } from "@filen/office/dom/presentation"
import {
	clipboardPayload,
	clipboardRefusalKey,
	clipOfPaste,
	forgetClips,
	heldClip,
	holdClip,
	pastedTextOp,
	planPaste,
	releaseClipsOf,
	type PasteTarget
} from "@/features/presentation/lib/presentationClipboard"

// The presentation editor's clipboard on the page: one clip for every open deck, recognised on the system clipboard
// by the HTML a copy wrote, and the paste it plans here or in another deck.

const SLIDE = slideRef(1)
const IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
const IMPORTED: ImportedSlide = {
	parts: [
		{
			name: "/ppt/slides/slide3.xml",
			contentType: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
			bytes: new Uint8Array([1])
		}
	],
	layout: { type: "obj", name: "Title and Content" }
}

function shapes(overrides: Partial<ShapeClip> = {}): ShapeClip {
	return {
		kind: "shapes",
		format: "pptx",
		slide: SLIDE,
		shapes: [{ raw: new TextEncoder().encode("<p:sp/>") }],
		boxes: [{ x: 10, y: 10, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false }],
		relationships: [],
		text: [["Hello"]],
		...overrides
	}
}

function session() {
	return {
		clipParts: vi.fn(() => Promise.resolve({ ok: true as const, parts: [] })),
		clipSlides: vi.fn((): Promise<ClipSlidesResult> => Promise.resolve({ ok: true, slides: [IMPORTED] }))
	}
}

function target(on: ReturnType<typeof session>, overrides: Partial<PasteTarget> = {}): PasteTarget {
	return { session: on, format: "pptx", order: [SLIDE, slideRef(2)], current: 0, slide: SLIDE, boxes: [], ...overrides }
}

afterEach(() => {
	forgetClips()
})

describe("the presentation clipboard", () => {
	it("pastes the held clip when the clipboard's HTML names it, and not another app's", () => {
		const held = holdClip(shapes(), session(), "clip-1")
		const { html, text } = clipboardPayload(held)

		expect(clipOfPaste({ html, text, files: [] })).toBe(held)
		expect(clipOfPaste({ html: "<p>Hello</p>", text: "Hello", files: [] })).toBeUndefined()
		// A browser that hands the page text only: the clip when it is its text.
		expect(clipOfPaste({ html: "", text: "Hello", files: [] })).toBe(held)
		expect(clipOfPaste({ html: "", text: "Other", files: [] })).toBeUndefined()
		// The clipboard not read at all (the browser refused): the held clip.
		expect(clipOfPaste(null)).toBe(held)
		// A newer copy: an older clip's HTML pastes nothing of it.
		holdClip(shapes(), session(), "clip-2")
		expect(clipOfPaste({ html, text, files: [] })).toBeUndefined()
	})

	it("plans a paste of shapes onto the slide in view, cascading over the copies already there", async () => {
		const deck = session()
		const held = holdClip(shapes(), deck)
		const plan = await planPaste(
			held,
			target(deck, { boxes: [{ x: 10, y: 10, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false }] })
		)

		expect(plan).toMatchObject({ kind: "shapes", slide: SLIDE, op: { kind: "paste", dx: 95_250, dy: 95_250 } })
		expect(deck.clipParts).not.toHaveBeenCalled()
	})

	it("asks the deck a clip came from for its parts when the paste is into another", async () => {
		const source = session()
		const bytes = new Uint8Array([1, 2])

		source.clipParts.mockResolvedValue({
			ok: true,
			parts: [{ name: "ppt/media/image1.png", bytes, contentType: "image/png" }]
		} as never)

		const held = holdClip(shapes({ relationships: [{ id: "rId2", type: IMAGE, target: "ppt/media/image1.png" }] }), source)
		const plan = await planPaste(held, target(session()))

		expect(source.clipParts).toHaveBeenCalledWith(["ppt/media/image1.png"])
		expect(plan).toMatchObject({ kind: "shapes", op: { relationships: [{ id: "rId2", bytes }] } })
	})

	it("tells what is gone when the deck a clip came from closed", async () => {
		const source = session()

		source.clipParts.mockRejectedValue(new Error("closed"))

		const held = holdClip(shapes({ relationships: [{ id: "rId2", type: IMAGE, target: "ppt/media/image1.png" }] }), source)

		expect(await planPaste(held, target(session()))).toEqual({ kind: "refused", reason: "notFound" })
		expect(clipboardRefusalKey("notFound", true)).toBe("previewPptxClipboardGone")
	})

	it("plans slides after the slide in view, and into another deck as the slides it hands over", async () => {
		const deck = session()
		const clip: SlideClip = { kind: "slides", format: "pptx", slides: [SLIDE], text: [] }
		const held = holdClip(clip, deck)

		expect(await planPaste(held, target(deck))).toEqual({
			kind: "slides",
			ops: [{ family: "slide", kind: "duplicate", slide: SLIDE, at: 1 }],
			select: 1
		})
		expect(deck.clipSlides).not.toHaveBeenCalled()
		expect(await planPaste(held, target(session()))).toEqual({
			kind: "slides",
			ops: [{ family: "slide", kind: "import", at: 1, slides: [IMPORTED] }],
			select: 1
		})
		expect(deck.clipSlides).toHaveBeenCalledWith([SLIDE])
		// Between formats: refused.
		expect(await planPaste(held, target(session(), { format: "odp" }))).toEqual({ kind: "refused", reason: "unsupported" })
		expect(clipboardRefusalKey("unsupported", true)).toBe("previewPptxClipboardNotHere")
		expect(clipboardRefusalKey("unsupported", false)).toBe("previewPptxClipboardNotCopied")
	})

	it("pastes a cut's slides into another deck as they were cut, and tells what is gone when the deck closed", async () => {
		const deck = session()
		const cut = holdClip({ kind: "slides", format: "pptx", slides: [SLIDE], text: [], foreign: [IMPORTED] }, deck)

		expect(await planPaste(cut, target(session()))).toMatchObject({ kind: "slides", ops: [{ kind: "import", slides: [IMPORTED] }] })
		expect(deck.clipSlides).not.toHaveBeenCalled()

		const closed = session()

		closed.clipSlides.mockRejectedValue(new Error("closed"))

		const copied = holdClip({ kind: "slides", format: "pptx", slides: [SLIDE], text: [] }, closed)

		expect(await planPaste(copied, target(session()))).toEqual({ kind: "refused", reason: "notFound" })
	})

	it("lets go of a clip that needs its closing deck, and keeps one that does not", () => {
		const deck = session()

		holdClip(shapes(), deck)
		releaseClipsOf(deck)
		expect(heldClip()).toBeDefined()

		holdClip({ kind: "slides", format: "pptx", slides: [SLIDE], text: [] }, deck)
		releaseClipsOf(deck)
		expect(heldClip()).toBeUndefined()

		// A cut's slides carry what another deck takes of them.
		holdClip({ kind: "slides", format: "pptx", slides: [SLIDE], text: [], foreign: [IMPORTED] }, deck)
		releaseClipsOf(deck)
		expect(heldClip()).toBeDefined()
	})

	it("makes another app's text a text box, a paragraph a line", () => {
		const op = pastedTextOp(insertTextBoxOp({ size: { cx: 9_144_000, cy: 6_858_000 }, format: "pptx" }, SLIDE, 5), "One\r\nTwo\u0001\n")

		expect(op).toMatchObject({ kind: "insert", shape: { txBox: true } })
		expect(op.family === "shape" && op.kind === "insert" ? op.shape.text?.paragraphs.map(paragraph => paragraph.runs) : []).toEqual([
			[{ kind: "r", text: "One", rPr: {} }],
			[{ kind: "r", text: "Two", rPr: {} }]
		])
	})
})
