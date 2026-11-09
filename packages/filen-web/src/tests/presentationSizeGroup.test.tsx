// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type ShapeLocks, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import { pictureGroups } from "@/features/presentation/components/ribbon/picture"
import { shapeFormatGroups } from "@/features/presentation/components/ribbon/shapeFormat"
import type { PresentationGroups, PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import { lengthUnit } from "@/features/preview/components/docxEditor.logic"
import { previewPptxObjects } from "@/locales/en/previewPptx/objects"
import "@/lib/i18n"

// The Size group of the Shape Format and Picture tabs: one field value only when every selected frame shares it, one
// undo step for all of them, each frame keeping the aspect its file locks, and off when any frame is locked against
// resizing.

i18n.addResourceBundle("en", "preview", previewPptxObjects, true, false)

const ref = slideRef(256)
const UNIT = lengthUnit(navigator.language)
const EMU_PER_UNIT = UNIT === "in" ? 914_400 : 360_000

interface Frame {
	readonly id: number
	readonly role: "shape" | "placeholder" | "picture"
	readonly cx: number
	readonly cy: number
	readonly locks?: ShapeLocks
	readonly lock?: "master"
}

function xfrmOf(frame: Frame): Xfrm {
	return { x: 1000, y: 2000, cx: frame.cx, cy: frame.cy, rot: 0, flipH: false, flipV: false }
}

function renderOf(frames: readonly Frame[]): SlideRender {
	const layers = frames.map(
		frame =>
			({
				shape: { slide: ref, id: frame.id },
				role: frame.role,
				drawing: {},
				matrix: [1, 0, 0, 1, 0, 0],
				...(frame.lock === undefined ? {} : { lock: frame.lock }),
				box: { id: frame.id, xfrm: xfrmOf(frame), ...(frame.locks === undefined ? {} : { locks: frame.locks }) }
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

function mount(groups: PresentationGroups, id: string, frames: readonly Frame[]): DeckOp[] {
	const selection = createShapeSelection()
	const ops: DeckOp[] = []

	selection.show(ref)
	selection.set(frames.map(frame => frame.id))

	const context: PresentationRibbonContext = {
		editable: true,
		phone: false,
		selection: new Set(["shape", "picture"]),
		t: i18n.t.bind(i18n),
		editor: {
			info: { format: "pptx", slides: [{ ref, hidden: false }], editable: true } as unknown as OpenInfo,
			render: renderOf(frames),
			selection,
			session: {} as PresentationSessionApi,
			command: (op: DeckOp): Promise<CommandResult> => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
			}
		}
	}
	const group = groups(context).find(entry => entry.id === id)

	if (group === undefined) throw new Error(`no group ${id}`)

	expect(group.label).toBe("Size")
	render(<>{group.content}</>)

	return ops
}

function field(name: "Height" | "Width"): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>("textbox", { name: `${name} (${UNIT})` })
}

function type(name: "Height" | "Width", value: string): void {
	fireEvent.change(field(name), { target: { value } })
	fireEvent.keyDown(field(name), { key: "Enter" })
}

function setXfrms(op: DeckOp | undefined): { id: number; xfrm: Xfrm }[] {
	const ops = op?.family === "batch" ? op.ops : op === undefined ? [] : [op]

	return ops.map(entry => {
		if (entry.family !== "shape" || entry.kind !== "setXfrm" || entry.xfrm === undefined) throw new Error("not a setXfrm")

		return { id: entry.target.id, xfrm: entry.xfrm }
	})
}

afterEach(() => {
	cleanup()
})

describe("Shape Format ▸ Size", () => {
	it("shows a side only when every shape shares it and resizes them all in one step, keeping a locked aspect", () => {
		const ops = mount(shapeFormatGroups, "shapeSize", [
			{ id: 1, role: "shape", cx: 2 * EMU_PER_UNIT, cy: EMU_PER_UNIT },
			{ id: 2, role: "placeholder", cx: 4 * EMU_PER_UNIT, cy: EMU_PER_UNIT, locks: { noChangeAspect: true } }
		])

		expect(field("Height").value).toBe("1")
		expect(field("Width").value).toBe("")

		type("Height", "2")

		expect(ops).toHaveLength(1)
		expect(ops[0]?.family).toBe("batch")
		expect(setXfrms(ops[0])).toEqual([
			{ id: 1, xfrm: { x: 1000, y: 2000, cx: 2 * EMU_PER_UNIT, cy: 2 * EMU_PER_UNIT, rot: 0, flipH: false, flipV: false } },
			{ id: 2, xfrm: { x: 1000, y: 2000, cx: 8 * EMU_PER_UNIT, cy: 2 * EMU_PER_UNIT, rot: 0, flipH: false, flipV: false } }
		])
	})

	it("leaves out a shape already that size, and sends nothing when none changes", () => {
		const ops = mount(shapeFormatGroups, "shapeSize", [
			{ id: 1, role: "shape", cx: 2 * EMU_PER_UNIT, cy: EMU_PER_UNIT },
			{ id: 2, role: "shape", cx: 3 * EMU_PER_UNIT, cy: EMU_PER_UNIT }
		])

		type("Width", "3")
		expect(ops).toHaveLength(1)
		expect(ops[0]?.family).toBe("shape")
		expect(setXfrms(ops[0]).map(entry => entry.id)).toEqual([1])
	})

	it("is off when any shape is locked against resizing", () => {
		const ops = mount(shapeFormatGroups, "shapeSize", [
			{ id: 1, role: "shape", cx: EMU_PER_UNIT, cy: EMU_PER_UNIT },
			{ id: 2, role: "shape", cx: EMU_PER_UNIT, cy: EMU_PER_UNIT, locks: { noResize: true } }
		])

		expect(field("Width").disabled).toBe(true)
		expect(field("Height").disabled).toBe(true)
		expect(ops).toEqual([])
	})

	it("refuses a length that would take a locked aspect out of range, restoring the field", () => {
		const ops = mount(shapeFormatGroups, "shapeSize", [
			{ id: 1, role: "shape", cx: EMU_PER_UNIT, cy: EMU_PER_UNIT },
			// 40 in wide: doubling it passes the 51 in PowerPoint takes.
			{ id: 2, role: "shape", cx: 40 * 914_400, cy: EMU_PER_UNIT, locks: { noChangeAspect: true } }
		])

		type("Height", "2")
		expect(ops).toEqual([])
		expect(field("Height").value).toBe("1")
	})
})

describe("Picture ▸ Size", () => {
	it("sizes the selected pictures only, and not a master's", () => {
		const ops = mount(pictureGroups, "pictureSize", [
			{ id: 1, role: "picture", cx: EMU_PER_UNIT, cy: EMU_PER_UNIT },
			{ id: 2, role: "shape", cx: 5 * EMU_PER_UNIT, cy: 5 * EMU_PER_UNIT },
			{ id: 3, role: "picture", cx: 7 * EMU_PER_UNIT, cy: 7 * EMU_PER_UNIT, lock: "master" }
		])

		expect(field("Width").value).toBe("1")

		type("Width", "2")
		expect(setXfrms(ops[0]).map(entry => [entry.id, entry.xfrm.cx, entry.xfrm.cy])).toEqual([[1, 2 * EMU_PER_UNIT, EMU_PER_UNIT]])
	})
})
