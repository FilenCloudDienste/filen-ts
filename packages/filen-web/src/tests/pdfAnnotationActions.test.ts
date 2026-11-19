import { describe, expect, it, vi } from "vitest"
import type { PdfCommandResult } from "@filen/office/core/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { applied, postComment } from "@/features/pdf/annotations/annotationActions"
import type { PdfAnnotationStore, PdfComposing } from "@/features/pdf/annotations/annotationStore"
import { fakeToolContext } from "@/tests/support/pdfToolContext"

// What the editor does with a change: runs it on `session` (its rejection kept, as the host shows it), or drops it.
function contextThat(fate: { readonly session: PdfEditSessionModel } | "drops") {
	const changes: Promise<unknown>[] = []
	const context = fakeToolContext({
		edit: (change, dropped) => {
			if (fate === "drops") dropped?.()
			else changes.push(change(fate.session).catch((error: unknown) => error))
		}
	})

	return { context, changes }
}

function sessionAnswering(dispatch: PdfEditSessionModel["dispatch"]): PdfEditSessionModel {
	return { dispatch } as unknown as PdfEditSessionModel
}

const RESULT = { pages: [0], widgets: [] } as unknown as PdfCommandResult

function fakeStore() {
	return { compose: vi.fn(), selectRef: vi.fn() }
}

describe("applied", () => {
	it("answers true when the change applies", async () => {
		const { context } = contextThat({ session: sessionAnswering(vi.fn()) })

		expect(await applied(context, () => Promise.resolve(RESULT))).toBe(true)
	})

	it("answers false when the editor refuses the change, which still reaches the host", async () => {
		const { context, changes } = contextThat({ session: sessionAnswering(vi.fn()) })
		const refusal = new Error("refused")

		expect(await applied(context, () => Promise.reject(refusal))).toBe(false)
		expect(await Promise.all(changes)).toEqual([refusal])
	})

	it("answers false when the change is dropped", async () => {
		const { context } = contextThat("drops")
		const change = vi.fn(() => Promise.resolve(RESULT))

		expect(await applied(context, change)).toBe(false)
		expect(change).not.toHaveBeenCalled()
	})
})

describe("postComment", () => {
	const note: PdfComposing = { kind: "note", page: 2, at: [10, 20] }

	it("answers the new note's id, clears composing and selects it", async () => {
		const dispatch = vi.fn(() => Promise.resolve({ ...RESULT, created: { page: 2, id: 41 } }))
		const { context } = contextThat({ session: sessionAnswering(dispatch) })
		const store = fakeStore()

		expect(await postComment(context, store as unknown as PdfAnnotationStore, note, "hello", "Ann")).toBe("41")
		expect(dispatch).toHaveBeenCalledWith("annotations.note", { page: 2, at: [10, 20], text: "hello", author: "Ann" })
		expect(store.compose).toHaveBeenCalledWith(null)
		expect(store.selectRef).toHaveBeenCalledWith({ page: 2, id: 41 })
	})

	it("answers the commented annotation's id for a first note on it", async () => {
		const dispatch = vi.fn(() => Promise.resolve(RESULT))
		const { context } = contextThat({ session: sessionAnswering(dispatch) })
		const store = fakeStore()
		const comment: PdfComposing = { kind: "comment", ref: { page: 1, id: 7 } }

		expect(await postComment(context, store as unknown as PdfAnnotationStore, comment, "first", "Ann")).toBe("7")
		expect(dispatch).toHaveBeenCalledWith("annotations.text", { page: 1, id: 7, text: "first" })
		expect(store.compose).toHaveBeenCalledWith(null)
	})

	it("answers null on refusal, composing cleared and nothing selected", async () => {
		const { context } = contextThat({ session: sessionAnswering(() => Promise.reject(new Error("refused"))) })
		const store = fakeStore()

		expect(await postComment(context, store as unknown as PdfAnnotationStore, note, "hello", "Ann")).toBeNull()
		expect(store.compose).toHaveBeenCalledWith(null)
		expect(store.selectRef).not.toHaveBeenCalled()
	})

	it("answers null when dropped and keeps the comment being written", async () => {
		const { context } = contextThat("drops")
		const store = fakeStore()

		expect(await postComment(context, store as unknown as PdfAnnotationStore, note, "hello", "Ann")).toBeNull()
		expect(store.compose).not.toHaveBeenCalled()
		expect(store.selectRef).not.toHaveBeenCalled()
	})
})
