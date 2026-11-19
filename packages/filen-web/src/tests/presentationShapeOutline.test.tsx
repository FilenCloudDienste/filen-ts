// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import { shapeFormatGroups } from "@/features/presentation/components/ribbon/shapeFormat"
import type { PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import { previewPptxObjects } from "@/locales/en/previewPptx/objects"
import "@/lib/i18n"

// The Shape Format tab's outline: a weight or colour pick changes only that field of each selected shape's line (the
// worker keeps the rest), one step for all of them; No outline still replaces the line.

i18n.addResourceBundle("en", "preview", previewPptxObjects, true, false)

const ref = slideRef(256)

function renderOf(ids: readonly number[]): SlideRender {
	const layers = ids.map(
		id =>
			({
				shape: { slide: ref, id },
				role: "shape",
				drawing: {},
				matrix: [1, 0, 0, 1, 0, 0],
				box: { id, xfrm: { x: 0, y: 0, cx: 1000, cy: 1000, rot: 0, flipH: false, flipV: false } }
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

function mount(ids: readonly number[]): DeckOp[] {
	const selection = createShapeSelection()
	const ops: DeckOp[] = []

	selection.show(ref)
	selection.set([...ids])

	const context: PresentationRibbonContext = {
		editable: true,
		phone: false,
		selection: new Set(["shape"]),
		t: i18n.t.bind(i18n),
		editor: {
			info: { format: "pptx", slides: [{ ref, hidden: false }], editable: true } as unknown as OpenInfo,
			render: renderOf(ids),
			selection,
			session: {} as PresentationSessionApi,
			command: (op: DeckOp): Promise<CommandResult> => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
			}
		}
	}
	const group = shapeFormatGroups(context).find(entry => entry.id === "shapeStyles")

	if (group === undefined) throw new Error("no shapeStyles group")

	render(<>{group.content}</>)

	return ops
}

function open(): void {
	fireEvent.click(screen.getByRole("button", { name: "Shape outline" }))
}

function shapeOps(op: DeckOp | undefined): DeckOp[] {
	return op?.family === "batch" ? [...op.ops] : op === undefined ? [] : [op]
}

afterEach(() => {
	cleanup()
})

describe("Shape Format ▸ Shape outline", () => {
	it("a weight pick sends only the weight for every selected shape, in one step", async () => {
		const ops = mount([1, 2])

		open()
		fireEvent.click(await screen.findByRole("button", { name: "4.5 pt" }))

		expect(ops).toHaveLength(1)
		expect(shapeOps(ops[0])).toEqual([
			{ family: "shape", kind: "patchLine", target: { slide: ref, id: 1 }, line: { w: 57_150 } },
			{ family: "shape", kind: "patchLine", target: { slide: ref, id: 2 }, line: { w: 57_150 } }
		])
	})

	it("a colour pick sends only the colour", async () => {
		const ops = mount([1])

		open()
		fireEvent.click(await screen.findByRole("button", { name: "Blue" }))

		expect(shapeOps(ops[0])).toEqual([
			{
				family: "shape",
				kind: "patchLine",
				target: { slide: ref, id: 1 },
				line: { fill: { kind: "solid", color: { kind: "srgb", rgb: "0070C0" } } }
			}
		])
	})

	it("No outline replaces the line", async () => {
		const ops = mount([1])

		open()
		fireEvent.click(await screen.findByRole("button", { name: "No outline" }))

		expect(shapeOps(ops[0])).toEqual([{ family: "shape", kind: "setProps", target: { slide: ref, id: 1 }, props: { ln: "none" } }])
	})
})
