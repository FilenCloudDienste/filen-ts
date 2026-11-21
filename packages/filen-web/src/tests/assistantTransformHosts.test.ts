// @vitest-environment jsdom

// Each editor's side of the selection transform applies the raw result as one undo step, and a selection taken earlier
// refuses once its text was edited.
import { afterEach, describe, expect, it, vi } from "vitest"
import { EditorState, EditorSelection } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { history, undo } from "@codemirror/commands"
import Quill from "quill"
import { textFieldTransform, type TransformSelection } from "@/features/assistant/transform/host"
import { codeMirrorTransformHost } from "@/features/preview/lib/codeMirrorTransformHost"
import { quillTransformHost } from "@/features/notes/components/editor/richTextTransformHost"

const RAW = "Fish &amp; chips at a\\.b"

// jsdom lays nothing out; Quill measures a selection as it scrolls to it.
Range.prototype.getBoundingClientRect = () => new DOMRect()
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })

function taken(selection: TransformSelection | "unsupported" | null): TransformSelection {
	if (selection === null || selection === "unsupported") {
		throw new Error("no selection")
	}

	return selection
}

afterEach(() => {
	document.body.replaceChildren()
	vi.restoreAllMocks()
})

describe("text field host", () => {
	function field(value: string, start: number, end: number): HTMLTextAreaElement {
		const element = document.createElement("textarea")

		element.value = value
		document.body.append(element)
		element.setSelectionRange(start, end)

		return element
	}

	function execCommandAs(run: (command: string, value: string) => boolean): void {
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: (command: string, _ui: boolean, value: string) => run(command, value)
		})
	}

	it("inserts through the browser's own insertText, which keeps the field's undo", () => {
		const element = field("say fish and chips now", 4, 18)
		const transform = textFieldTransform()
		const write = vi.fn()
		const inserted: string[] = []

		transform.attach(element, write)
		execCommandAs((command, value) => {
			inserted.push(`${command}:${value}`)
			element.setRangeText(value, element.selectionStart, element.selectionEnd, "end")

			return true
		})

		const selection = taken(transform.host.selection())

		expect(selection.text).toBe("fish and chips")
		expect(selection.replace(RAW)).toEqual({ undo: null })
		expect(inserted).toEqual([`insertText:${RAW}`])
		expect(element.value).toBe(`say ${RAW} now`)
		expect(write).not.toHaveBeenCalled()
		expect(element.value.slice(element.selectionStart, element.selectionEnd)).toBe(RAW)
	})

	it("falls back to setting the value with a one-level undo where insertText is refused", () => {
		const element = field("say fish now", 4, 8)
		const transform = textFieldTransform()
		const write = vi.fn((value: string) => {
			element.value = value
		})

		transform.attach(element, write)
		execCommandAs(() => false)

		const applied = taken(transform.host.selection()).replace(RAW)

		expect(write).toHaveBeenLastCalledWith(`say ${RAW} now`, { start: 4, end: 4 + RAW.length })
		expect(applied?.undo?.()).toBe(true)
		expect(write).toHaveBeenLastCalledWith("say fish now", { start: 4, end: 8 })
		// Once edited after, the undo no longer applies.
		element.value = "changed"
		expect(applied?.undo?.()).toBe(false)
	})

	it("refuses once the field's text changed, and offers nothing without a selection", () => {
		const element = field("one two", 0, 3)
		const transform = textFieldTransform()

		transform.attach(element, vi.fn())

		const selection = taken(transform.host.selection())

		element.value = "one two three"
		expect(selection.current()).toBe(false)
		expect(selection.replace("x")).toBeNull()
		element.setSelectionRange(2, 2)
		expect(transform.host.selection()).toBeNull()
		expect(transform.host.selectionRect()).toBeNull()
	})
})

describe("CodeMirror host", () => {
	function view(doc: string, from: number, to: number): EditorView {
		const parent = document.createElement("div")

		document.body.append(parent)

		return new EditorView({
			parent,
			state: EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [history()] })
		})
	}

	it("replaces the selection as an undo step of its own, typing just before it included", () => {
		const editor = view("hello world", 6, 11)
		const host = codeMirrorTransformHost(() => editor)

		// Typed right before: history would join an adjacent change made within its delay.
		editor.dispatch({ changes: { from: 0, insert: "a" }, selection: EditorSelection.single(7, 12), userEvent: "input.type" })

		const selection = taken(host.selection())

		expect(selection.text).toBe("world")
		expect(selection.replace(RAW)).toEqual({ undo: null })
		expect(editor.state.doc.toString()).toBe(`ahello ${RAW}`)
		expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe(RAW)
		expect(undo(editor)).toBe(true)
		expect(editor.state.doc.toString()).toBe("ahello world")
		editor.destroy()
	})

	it("refuses once the text changed, and a read-only editor offers nothing", () => {
		const editor = view("hello world", 0, 5)
		const host = codeMirrorTransformHost(() => editor)
		const selection = taken(host.selection())

		editor.dispatch({ changes: { from: 11, insert: "!" } })
		expect(selection.current()).toBe(false)
		expect(selection.replace("Hi")).toBeNull()
		editor.dispatch({ effects: [], selection: EditorSelection.single(0, 0) })
		expect(host.selection()).toBeNull()
		editor.destroy()

		const locked = new EditorView({
			parent: document.body,
			state: EditorState.create({ doc: "abc", selection: EditorSelection.single(0, 2), extensions: [EditorState.readOnly.of(true)] })
		})

		expect(codeMirrorTransformHost(() => locked).selection()).toBeNull()
		locked.destroy()
	})
})

describe("Quill host", () => {
	function quill(text: string): Quill {
		const container = document.createElement("div")

		document.body.append(container)

		const editor = new Quill(container, { formats: ["bold", "italic", "header"], modules: { toolbar: false } })

		editor.setText(text, "silent")

		return editor
	}

	it("replaces with user edits fenced by history cutoffs: one undo takes it back, the shared formats kept", () => {
		const editor = quill("make this bold\n")
		const transform = quillTransformHost()
		const changes: string[] = []

		transform.attach(editor)
		editor.formatText(5, 4, "bold", true, "silent")
		editor.on("text-change", (_delta, _old, source) => changes.push(source))
		editor.setSelection(5, 4, "user")

		const selection = taken(transform.host.selection())

		expect(selection.text).toBe("this")
		expect(selection.replace("THAT")).toEqual({ undo: null })
		expect(editor.getText()).toBe("make THAT bold\n")
		expect(editor.getFormat(5, 4)).toEqual({ bold: true })
		expect(changes.every(source => source === "user")).toBe(true)
		;(editor.getModule("history") as { undo: () => void }).undo()
		expect(editor.getText()).toBe("make this bold\n")
	})

	it("refuses once the text changed", () => {
		const editor = quill("one two\n")
		const transform = quillTransformHost()

		transform.attach(editor)
		editor.setSelection(0, 3, "user")

		const selection = taken(transform.host.selection())

		editor.insertText(7, "!", "user")
		expect(selection.current()).toBe(false)
		expect(selection.replace("1")).toBeNull()
	})
})
