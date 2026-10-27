// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { Schema, type Node } from "prosemirror-model"
import { slideRef, type DeckOp } from "@filen/office/core/presentation"
import {
	FIND_IN_NOTES,
	FIND_IN_SMARTART,
	FIND_IN_TABLE,
	type CommandResult,
	type OpenInfo,
	type PresentationSessionApi
} from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing, type TextEditController } from "@filen/office/react/presentation"
import {
	findOffsetToPos,
	replaceTargets,
	usePresentationFind,
	type PresentationFindEditor
} from "@/features/presentation/components/presentationFind"

// Find and replace in the presentation editor: find-text offsets map to editor positions through breaks, fields and
// kept content; replace-all targets one op per shape (notes apart, tables and SmartArt in an op of their own); the
// controls search the worker, step to a match's slide and shape and select it in the opened body, and send the open
// body's text before any replace.

// The editing schema's shape (paragraphs of text, a:br, fields): what findOffsetToPos walks.
const schema = new Schema({
	nodes: {
		doc: { content: "paragraph+" },
		paragraph: { content: "inline*" },
		text: { group: "inline" },
		br: { group: "inline", inline: true, atom: true },
		field: { group: "inline", inline: true, atom: true, attrs: { text: { default: "" } } }
	}
})

// "Hello" / "ab", a slide number field showing "12", a break, "cd".
function bodyDoc(): Node {
	return schema.node("doc", null, [
		schema.node("paragraph", null, [schema.text("Hello")]),
		schema.node("paragraph", null, [schema.text("ab"), schema.node("field", { text: "12" }), schema.node("br"), schema.text("cd")])
	])
}

const S1 = slideRef(256)
const S2 = slideRef(257)
const INFO = {
	slides: [
		{ ref: S1, hidden: false },
		{ ref: S2, hidden: false }
	],
	editable: true
} as unknown as OpenInfo

// slide, shape, paragraph, start, end, flags
function matches(...rows: number[][]): Int32Array {
	return Int32Array.from(rows.flat())
}

describe("presentation find positions", () => {
	it("maps find-text offsets to editor positions through fields and breaks", () => {
		const doc = bodyDoc()

		expect(findOffsetToPos(doc, 0, 0)).toBe(1)
		expect(findOffsetToPos(doc, 0, 5)).toBe(6)
		// Paragraph 1 starts at 8: "ab" 8–10, the field (find text "12") one position, the break one.
		expect(findOffsetToPos(doc, 1, 1)).toBe(9)
		expect(findOffsetToPos(doc, 1, 2)).toBe(10)
		expect(findOffsetToPos(doc, 1, 4)).toBe(11)
		expect(findOffsetToPos(doc, 1, 5)).toBe(12)
		expect(findOffsetToPos(doc, 1, 6)).toBe(13)
		expect(findOffsetToPos(doc, 2, 0)).toBeUndefined()
	})

	it("targets each shape once, notes bodies apart, tables and SmartArt in an op of their own", () => {
		const found = matches(
			[0, 2, 0, 0, 1, 0],
			[0, 2, 1, 0, 1, 0],
			[0, 3, 0, 0, 1, FIND_IN_NOTES],
			[1, 4, 0, 0, 1, FIND_IN_TABLE],
			[1, 5, 2, 0, 1, FIND_IN_SMARTART]
		)

		expect(replaceTargets(found, 5, INFO)).toEqual({
			text: [{ target: { slide: S1, id: 2 } }, { target: { slide: S1, id: 3 }, notes: true }],
			other: [{ target: { slide: S2, id: 4 } }, { target: { slide: S2, id: 5 } }]
		})
	})
})

function editorFor(sent: DeckOp[], order: string[]): PresentationFindEditor & { opened: unknown[]; shown: number[] } {
	const text = createTextEditing()
	const opened: unknown[] = []
	const shown: number[] = []

	vi.spyOn(text, "flush").mockImplementation(() => {
		order.push("flush")

		return Promise.resolve()
	})

	return {
		text,
		selection: createShapeSelection(),
		opened,
		shown,
		show: index => {
			shown.push(index)
		},
		openText: shape => {
			opened.push(shape)
		},
		command: (op: DeckOp): Promise<CommandResult> => {
			order.push("command")
			sent.push(op)

			return Promise.resolve({ ok: true, revision: sent.length, dirty: true })
		}
	}
}

describe("presentation find controls", () => {
	it("searches the worker, steps to the match's slide and selects it in the body it opens", async () => {
		const found = matches([1, 7, 1, 0, 2, 0], [0, 3, 0, 0, 1, FIND_IN_NOTES])
		const find = vi.fn(() => Promise.resolve(found))
		const session = { find } as unknown as PresentationSessionApi
		const editor = editorFor([], [])
		const { result } = renderHook(() => usePresentationFind({ session, info: INFO, editor }))

		act(() => {
			result.current.search("ab", true)
		})
		await waitFor(() => {
			expect(result.current.count).toBe(2)
		})
		expect(find).toHaveBeenCalledWith("ab", { caseSensitive: true, limit: 10_000 })
		expect(result.current.active).toBe(0)

		act(() => {
			result.current.step(1)
		})
		expect(editor.shown).toEqual([0])
		// A notes match shows its slide only.
		expect(editor.opened).toEqual([])

		act(() => {
			result.current.step(1)
		})
		expect(editor.shown).toEqual([0, 1])
		expect(editor.selection.getSnapshot()).toMatchObject({ slide: S2, ids: [7] })
		expect(editor.opened).toEqual([{ slide: S2, id: 7 }])

		// The shell opens the body: the match is selected in it.
		const doc = bodyDoc()
		const setSelection = vi.fn()
		const controller = {
			shape: { slide: S2, id: 7 },
			state: { doc },
			setSelection,
			subscribe: () => () => undefined
		} as unknown as TextEditController

		act(() => {
			editor.text.set(controller)
		})
		expect(setSelection).toHaveBeenCalledWith(8, 10)
	})

	it("replace sends the open body first, then one replace op for one match or for all", async () => {
		const found = matches([0, 2, 0, 1, 3, 0], [0, 2, 0, 5, 7, 0], [1, 3, 0, 0, 2, FIND_IN_NOTES], [1, 4, 0, 0, 2, FIND_IN_TABLE])
		const find = vi.fn(() => Promise.resolve(found))
		const session = { find } as unknown as PresentationSessionApi
		const sent: DeckOp[] = []
		const order: string[] = []
		const replaced: number[] = []
		const editor = editorFor(sent, order)
		const { result } = renderHook(() => usePresentationFind({ session, info: INFO, editor, onReplaced: count => replaced.push(count) }))

		act(() => {
			result.current.search("xy", false)
		})
		await waitFor(() => {
			expect(result.current.count).toBe(4)
		})

		await act(async () => {
			result.current.replace?.one("Z")
			await Promise.resolve()
		})
		await waitFor(() => {
			expect(sent).toHaveLength(1)
		})
		expect(sent[0]).toEqual({
			family: "text",
			kind: "replace",
			query: "xy",
			replacement: "Z",
			caseSensitive: false,
			targets: [{ target: { slide: S1, id: 2 }, match: [0, 1, 3] }]
		})

		await act(async () => {
			result.current.replace?.all("Z")
			await Promise.resolve()
		})
		await waitFor(() => {
			expect(sent).toHaveLength(3)
		})
		expect(sent[1]).toMatchObject({
			kind: "replace",
			targets: [{ target: { slide: S1, id: 2 } }, { target: { slide: S2, id: 3 }, notes: true }]
		})
		// The table cell goes on its own (refused until tables are editable; the shell reports it).
		expect(sent[2]).toMatchObject({ kind: "replace", targets: [{ target: { slide: S2, id: 4 } }] })
		expect(order.slice(0, 2)).toEqual(["flush", "command"])
		expect(order.indexOf("flush", 2)).toBeLessThan(order.indexOf("command", 2))
		expect(replaced).toEqual([1, 3])
		// Every replace searches again.
		await waitFor(() => {
			expect(find).toHaveBeenCalledTimes(3)
		})
	})

	it("has no replace in a deck that is only viewed", () => {
		const session = { find: vi.fn(() => Promise.resolve(new Int32Array(0))) } as unknown as PresentationSessionApi
		const { result } = renderHook(() => usePresentationFind({ session, info: { ...INFO, editable: false }, editor: editorFor([], []) }))

		expect(result.current.replace).toBeUndefined()
	})
})
