import { describe, expect, it, vi } from "vitest"
import type { PdfAnnotationInfo } from "@filen/office/core/pdfedit/annotations"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { TOOL_MIN_SIZE } from "@filen/office/react/pdfedit/tools"
import { fakeToolContext } from "@/tests/support/pdfToolContext"

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { annotationStoreOf } = await import("@/features/pdf/annotations/annotationStore")
const { selectionKey } = await import("@/features/pdf/annotations/annotationKeys")

// An arrow the selection takes without a change (nothing left to shrink) is still handled, so it never scrolls the
// pages; one the selection cannot use (a locked annotation, a markup) is left to the viewer.

const INFO: PdfAnnotationInfo = {
	page: 0,
	id: 7,
	type: "Square",
	rect: [10, 10, 10 + TOOL_MIN_SIZE, 10 + TOOL_MIN_SIZE],
	color: [1, 0, 0],
	interiorColor: null,
	opacity: 1,
	width: 1,
	author: "Ann",
	created: null,
	modified: null,
	text: "",
	replyTo: null,
	geometry: "rect",
	locked: false
}

describe("selection keys", () => {
	it("takes an arrow that changes nothing, and leaves one the selection cannot use to the viewer", () => {
		const swap = {} as never
		const store = annotationStoreOf(swap)
		const edit = vi.fn<(change: (session: PdfEditSessionModel) => Promise<unknown>) => void>()
		const context = fakeToolContext({ edit, swap })
		const press = (key: "ArrowLeft" | "ArrowUp", alt: boolean) =>
			selectionKey({ kind: "down", key, shift: false, alt, page: 0 }, context)

		store.select(INFO)
		expect(press("ArrowLeft", true)).toBe(true)
		expect(press("ArrowUp", true)).toBe(true)
		expect(edit).not.toHaveBeenCalled()
		expect(store.getState().selected).toBe(INFO)

		store.select({ ...INFO, locked: true })
		expect(press("ArrowLeft", false)).toBe(false)
		expect(press("ArrowLeft", true)).toBe(false)

		const note = { ...INFO, type: "Text" }

		store.select(note)
		expect(press("ArrowLeft", true)).toBe(false)

		store.select({ ...INFO, geometry: null })
		expect(press("ArrowLeft", false)).toBe(false)
		expect(edit).not.toHaveBeenCalled()
	})
})
