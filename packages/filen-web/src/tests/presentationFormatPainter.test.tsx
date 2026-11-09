// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender, TextSeed } from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing, formatPainterOf } from "@filen/office/react/presentation"
import { homeGroups, painterTargets } from "@/features/presentation/components/ribbon/home"
import type { PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import "@/lib/i18n"

// Home ▸ Clipboard ▸ Format Painter in the presentation editor: offered while something with text is selected, a
// click picks up its formatting (the button stays pressed), and a placeholder's click opens its body for the paint.

const EMU = 9525
const ref = slideRef(256)
const box: Xfrm = { x: 0, y: 0, cx: 100 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false }

function renderOf(body: "placeholder" | "shape"): SlideRender {
	const layer = {
		shape: { slide: ref, id: 2 },
		role: body === "placeholder" ? "placeholder" : "shape",
		drawing: {},
		matrix: [1, 0, 0, 1, 0, 0],
		box: { id: 2, xfrm: box, body }
	} as unknown as SlideLayer

	return {
		ref,
		index: 0,
		revision: 1,
		hidden: false,
		background: {},
		layers: [layer],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

function contextOf(slide: SlideRender) {
	const selection = createShapeSelection()
	const text = createTextEditing()
	const session = {
		textSeed: (shape: { slide: number; id: number }) =>
			Promise.resolve({
				shape,
				revision: 1,
				body: { bodyPr: {}, paragraphs: [] },
				resolved: [{ pPr: {}, runs: [{ b: true }] }],
				page: {},
				layout: {},
				matrix: []
			} as unknown as TextSeed)
	} as unknown as PresentationSessionApi

	selection.show(ref)

	const context: PresentationRibbonContext = {
		editable: true,
		phone: false,
		selection: new Set(),
		t: i18n.t.bind(i18n),
		editor: {
			info: { slides: [{ ref, hidden: false }], customShows: [], editable: true } as unknown as OpenInfo,
			render: slide,
			selection,
			text,
			session,
			command: (_op: DeckOp): Promise<CommandResult> => Promise.resolve({ ok: true, revision: 1, dirty: true })
		}
	}

	return { context, selection, text }
}

afterEach(() => {
	cleanup()
})

describe("presentation format painter", () => {
	it("offers the painter in a Clipboard group, on once something with text is selected", async () => {
		const { context, selection, text } = contextOf(renderOf("shape"))
		const group = homeGroups(context).find(each => each.id === "clipboard")

		expect(group).toBeDefined()
		render(<>{group?.content}</>)

		const button = screen.getByRole("button", { name: "Format painter" })

		expect(button).toHaveProperty("disabled", true)

		selection.set([2])
		await waitFor(() => {
			expect(button).toHaveProperty("disabled", false)
		})

		fireEvent.click(button, { detail: 1 })
		await waitFor(() => {
			expect(formatPainterOf(text).mode).toBe("once")
		})
		expect(button.getAttribute("aria-pressed")).toBe("true")

		formatPainterOf(text).cancel()
	})

	it("aims at the selected text shapes; a placeholder's click opens its body for the paint", () => {
		const shape = contextOf(renderOf("shape"))

		shape.selection.set([2])
		expect(painterTargets({ render: renderOf("shape"), selection: shape.selection })()).toEqual({
			shapes: [{ slide: ref, id: 2 }],
			entersText: false
		})

		const placeholder = contextOf(renderOf("placeholder"))

		placeholder.selection.set([2])
		expect(painterTargets({ render: renderOf("placeholder"), selection: placeholder.selection })().entersText).toBe(true)
	})
})
