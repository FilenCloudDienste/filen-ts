// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type InsertedImage, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import { coverCrop, setPictureOp, smartArtPane } from "@/features/presentation/components/ribbon/insertSmartArt"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { SmartArtPrompts, SmartArtTextPane } from "@/features/presentation/components/smartartTextPane"
import { previewPptxSmartArt } from "@/locales/en/previewPptx/smartart"
import "@/lib/i18n"

// A picture into a SmartArt picture placeholder from the page: the crop that fills the placeholder, the text pane's
// per-item picture button (insert, or change once filled), and the click in an empty placeholder on the slide; each
// a file from this device made a slide picture, then one setPicture op.

const PICTURE: InsertedImage = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", width: 400, height: 200 }

vi.mock("@/features/presentation/components/ribbon/insertObjects", () => ({
	preparePresentationPicture: () => Promise.resolve({ ok: true, image: PICTURE })
}))

i18n.addResourceBundle("en", "preview", previewPptxSmartArt, true, false)

const EMU = 9525
const ref = slideRef(256)
const FRAME: Xfrm = { x: 100 * EMU, y: 50 * EMU, cx: 600 * EMU, cy: 400 * EMU, rot: 0, flipH: false, flipV: false }
const INFO = {
	format: "pptx",
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	customShows: [],
	editable: true
} as unknown as OpenInfo
const DIAGRAM = {
	root: "{ROOT}",
	nodes: [
		{ id: "{1}", level: 1, type: "node", text: "One" },
		{ id: "{2}", level: 1, type: "node", text: "Two" }
	],
	deckDefinitions: [],
	prompts: [],
	pictures: [
		{ x: 0, y: 0, w: 200 * EMU, h: 200 * EMU, node: "{1}", placeholder: "photo", filled: false },
		{ x: 300 * EMU, y: 0, w: 200 * EMU, h: 200 * EMU, node: "{2}", placeholder: "photo", filled: true }
	]
}

function editorOf(ops: DeckOp[]): PresentationRibbonEditor {
	const selection = createShapeSelection()

	selection.show(ref)
	selection.set([7])

	return {
		info: INFO,
		render: {
			ref,
			index: 0,
			revision: 1,
			hidden: false,
			background: {},
			layers: [
				{
					shape: { slide: ref, id: 7 },
					role: "smartart",
					drawing: {},
					matrix: [1, 0, 0, 1, 0, 0],
					box: { id: 7, xfrm: FRAME }
				} as unknown as SlideLayer
			],
			notesText: "",
			animated: false
		} as unknown as SlideRender,
		selection,
		session: { smartArtInfo: vi.fn(() => Promise.resolve(DIAGRAM)) } as unknown as PresentationSessionApi,
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
		}
	}
}

// A file chosen in the picker the picture command opens.
function chooseFiles(): void {
	vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
		Object.defineProperty(this, "files", { value: [new File([new Uint8Array([1])], "cat.png", { type: "image/png" })] })
		this.dispatchEvent(new Event("change"))
	})
}

beforeEach(() => {
	smartArtPane.reset()
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("SmartArt pictures", () => {
	it("crops a picture evenly to fill its placeholder", () => {
		expect(coverCrop({ width: 400, height: 200 }, { w: 100, h: 100 })).toEqual({ l: 25_000, t: 0, r: 25_000, b: 0 })
		expect(coverCrop({ width: 100, height: 400 }, { w: 200, h: 200 })).toEqual({ l: 0, t: 37_500, r: 0, b: 37_500 })
		expect(coverCrop({ width: 300, height: 200 }, { w: 3, h: 2 })).toBeUndefined()
	})

	it("names the node, its placeholder and the image in one op", () => {
		const target = { slide: ref, id: 7 }

		expect(setPictureOp(target, { ...DIAGRAM.pictures[0], filled: false } as never, PICTURE)).toEqual({
			family: "smartart",
			kind: "setPicture",
			target,
			node: "{1}",
			placeholder: "photo",
			image: PICTURE,
			crop: { l: 25_000, t: 0, r: 25_000, b: 0 }
		})
	})

	it("offers a picture per item in the text pane, insert or change, each one op", async () => {
		const ops: DeckOp[] = []
		const editor = editorOf(ops)

		chooseFiles()
		act(() => {
			smartArtPane.setOpen(true)
		})
		render(
			<SmartArtTextPane
				editor={editor}
				editable
				phone={false}
			/>
		)

		const insert = await screen.findByRole("button", { name: "Insert a picture for item 1" })

		expect(screen.getByRole("button", { name: "Change the picture of item 2" })).toBeDefined()
		fireEvent.click(insert)
		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		expect(ops[0]).toMatchObject({ family: "smartart", kind: "setPicture", node: "{1}", placeholder: "photo", image: PICTURE })
	})

	it("picks a picture from a click in an empty placeholder on the slide, none for a filled one", async () => {
		const ops: DeckOp[] = []
		const editor = editorOf(ops)

		chooseFiles()

		const { container } = render(
			<SmartArtPrompts
				editor={editor}
				scale={1}
			/>
		)

		await waitFor(() => {
			expect(container.querySelectorAll("[data-smartart-picture]")).toHaveLength(1)
		})
		const placeholder = container.querySelector("[data-smartart-picture]")

		if (placeholder === null) throw new Error("no picture placeholder")

		fireEvent.click(placeholder)
		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		expect(ops[0]).toMatchObject({ kind: "setPicture", node: "{1}" })
	})
})
