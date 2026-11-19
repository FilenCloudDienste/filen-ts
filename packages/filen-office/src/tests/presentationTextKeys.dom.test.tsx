// @vitest-environment happy-dom
import { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { DEFAULT_TEXT_BINDINGS, textKeyCommand } from "../react/presentation/edit/text/keys"
import { fakeSession, flushAll, frameWithLayers, mountEditor, seedOf } from "./presentationTextEditorFixtures.dom"

// The editor view's keys as the user's keymap binds them (a rebound key moves, the old one no longer acts; the link
// key asks the host for its dialog), and its painting: a new layout repaints only the lines that look different.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function key(target: Element, init: KeyboardEventInit): void {
	target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
}

async function mount(bindings = DEFAULT_TEXT_BINDINGS, text = "Hello") {
	const ops: DeckOp[] = []
	const frame = frameWithLayers()
	const session = {
		...fakeSession(ops, []),
		textSeed: () => Promise.resolve(seedOf(text))
	} as unknown as PresentationSessionApi

	const { root, editing } = await mountEditor(frame, { session, bindings })

	return { frame, editing, root, ops, sink: frame.querySelector(".fo-text-sink.ProseMirror") as HTMLElement }
}

describe("presentation text editor keys and painting", () => {
	afterEach(() => {
		document.body.replaceChildren()
	})

	it("follows a rebound key: the new combo acts, the default no longer does", async () => {
		const { editing, root, sink } = await mount({ ...DEFAULT_TEXT_BINDINGS, underline: "mod+shift+u" })
		const controller = editing.active

		controller?.setSelection(1, 3)
		key(sink, { key: "u", code: "KeyU", ctrlKey: true })
		expect(controller?.format().run.u).toBeUndefined()

		key(sink, { key: "U", code: "KeyU", ctrlKey: true, shiftKey: true })
		expect(controller?.format().run.u).toBe("sng")

		await act(async () => {
			root.unmount()
		})
	})

	it("steps the history on the undo and redo keys in effect, not on a key moved off them", async () => {
		const { editing, root, sink } = await mount({ ...DEFAULT_TEXT_BINDINGS, undo: "mod+alt+z" })
		const controller = editing.active

		if (controller === undefined) throw new Error("no body open")

		const step = vi.spyOn(controller, "step").mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof controller.step>>)

		key(sink, { key: "z", code: "KeyZ", ctrlKey: true })
		expect(step).not.toHaveBeenCalled()

		key(sink, { key: "z", code: "KeyZ", ctrlKey: true, altKey: true })
		key(sink, { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true })
		key(sink, { key: "y", code: "KeyY", ctrlKey: true })
		expect(step.mock.calls).toEqual([["undo"], ["redo"], ["redo"]])

		await act(async () => {
			root.unmount()
		})
	})

	it("Ctrl+= subscripts, Ctrl+Shift+= superscripts, again removes it; Ctrl+Space clears the formatting", async () => {
		const { editing, root, sink } = await mount()
		const controller = editing.active

		controller?.setSelection(1, 3)
		key(sink, { key: "=", code: "Equal", ctrlKey: true })
		expect(controller?.format().run.baseline).toBe(-25_000)
		key(sink, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true })
		expect(controller?.format().run.baseline).toBe(30_000)
		key(sink, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true })
		expect(controller?.format().run.baseline).toBeUndefined()

		key(sink, { key: "b", code: "KeyB", ctrlKey: true })
		key(sink, { key: "=", code: "Equal", ctrlKey: true })
		expect(controller?.format().run.b).toBe(true)
		const space = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " ", code: "Space", ctrlKey: true })

		sink.dispatchEvent(space)
		expect(space.defaultPrevented).toBe(true)
		expect(controller?.format().run.b).toBeUndefined()
		expect(controller?.format().run.baseline).toBeUndefined()

		await act(async () => {
			root.unmount()
		})
	})

	it("matches the baseline keys as PowerPoint does on each platform", () => {
		const press = (code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean }) => ({
			key: "",
			code,
			ctrlKey: mods.ctrl === true,
			metaKey: mods.meta === true,
			shiftKey: mods.shift === true,
			altKey: false
		})

		expect(textKeyCommand(press("Equal", { ctrl: true }), DEFAULT_TEXT_BINDINGS, false)).toBe("subscript")
		expect(textKeyCommand(press("Equal", { ctrl: true, shift: true }), DEFAULT_TEXT_BINDINGS, false)).toBe("superscript")
		expect(textKeyCommand(press("Space", { ctrl: true }), DEFAULT_TEXT_BINDINGS, false)).toBe("clearFormatting")
		// Mac: Cmd+Control+= and Cmd+Control+Shift+=; Cmd+= stays the browser's zoom; Control+Space, not Cmd+Space.
		expect(textKeyCommand(press("Equal", { ctrl: true, meta: true }), DEFAULT_TEXT_BINDINGS, true)).toBe("subscript")
		expect(textKeyCommand(press("Equal", { ctrl: true, meta: true, shift: true }), DEFAULT_TEXT_BINDINGS, true)).toBe("superscript")
		expect(textKeyCommand(press("Equal", { meta: true }), DEFAULT_TEXT_BINDINGS, true)).toBeUndefined()
		expect(textKeyCommand(press("Space", { ctrl: true }), DEFAULT_TEXT_BINDINGS, true)).toBe("clearFormatting")
		expect(textKeyCommand(press("Space", { meta: true }), DEFAULT_TEXT_BINDINGS, true)).toBeUndefined()
	})

	it("the link key asks the host for its dialog", async () => {
		const { editing, root, sink } = await mount()
		const asked: number[] = []
		const off = editing.onLinkRequest(() => asked.push(1))

		key(sink, { key: "k", code: "KeyK", ctrlKey: true })
		expect(asked).toEqual([1])
		off()

		await act(async () => {
			root.unmount()
		})
	})

	it("a new layout repaints only the lines that changed", async () => {
		const { frame, editing, root } = await mount(DEFAULT_TEXT_BINDINGS, "Hello")
		const controller = editing.active

		expect(controller).toBeDefined()
		// Three paragraphs ("", "Hello", ""): type into the last only.
		controller?.run((state, dispatch) => {
			dispatch?.(state.tr.split(6).split(1))

			return true
		})
		await flushAll()

		const before = [...frame.querySelectorAll(".fo-text-editor .fo-docx-line")]

		expect(before.length).toBe(3)
		controller?.dispatch(controller.state.tr.insertText("!", controller.state.doc.content.size - 1), true)
		await flushAll()

		const after = [...frame.querySelectorAll(".fo-text-editor .fo-docx-line")]

		expect(after.length).toBe(3)
		expect(after[0]).toBe(before[0])
		expect(after[1]).toBe(before[1])
		expect(after[2]).not.toBe(before[2])

		await act(async () => {
			root.unmount()
		})
	})
})
