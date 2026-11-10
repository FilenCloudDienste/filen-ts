// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { PresentationTextEditor } from "../react/presentation/edit/text/TextEditor"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import { DEFAULT_TEXT_BINDINGS, textKeyCommand } from "../react/presentation/edit/text/keys"
import { FakeMeasurer, testFont } from "./textFixtures"

// The editor view's keys as the user's keymap binds them (a rebound key moves, the old one no longer acts; the link
// key asks the host for its dialog), and its painting: a new layout repaints only the lines that look different.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHAPE: ShapeRef = { slide: slideRef(7), id: 3 }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }

function laid(body: TextBody) {
	const result = layoutBody(
		resolveBody(body, { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }),
		{ width: 300, height: 100 },
		ENV
	)

	return { page: result.page, layout: transferableLayout(result) }
}

function seedOf(text: string): TextSeed {
	const body: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }

	return { shape: SHAPE, revision: 1, body, resolved: [{ pPr: {}, runs: [{}] }], ...laid(body), matrix: [1, 0, 0, 1, 40, 50] }
}

function fakeSession(ops: DeckOp[], undos: (ShapeRef | undefined)[]): PresentationSessionApi {
	return {
		textSeed: () => Promise.resolve(seedOf("Hello")),
		layoutText: (_shape: ShapeRef, body: TextBody) => Promise.resolve({ ...laid(body), revision: 2 }),
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length + 1, dirty: true })
		},
		undo: (open?: ShapeRef): Promise<CommandResult> => {
			undos.push(open)

			return Promise.resolve({ ok: true, revision: 9, dirty: false, seed: seedOf("Hello") })
		}
	} as unknown as PresentationSessionApi
}

// A slide painted the way paintSlide marks it: layer 0 is the layout's, layer 1 the shape's own.
function frameWithLayers(): HTMLElement {
	const frame = document.createElement("div")

	frame.className = "fo-slide-frame"
	frame.innerHTML =
		'<div class="fo-slide-content"><div class="fo-slide-layer" data-fo-layer="0"><div class="fo-slide-text">layout</div></div>' +
		'<div class="fo-slide-layer" data-fo-layer="1"><div class="fo-slide-text">Hello</div></div></div>'
	document.body.append(frame)

	return frame
}

async function flushAll(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

function key(target: Element, init: KeyboardEventInit): void {
	target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
}

async function mount(bindings = DEFAULT_TEXT_BINDINGS, text = "Hello") {
	const ops: DeckOp[] = []
	const frame = frameWithLayers()
	const editing = createTextEditing()
	const root = createRoot(frame)
	const session = {
		...fakeSession(ops, []),
		textSeed: () => Promise.resolve(seedOf(text))
	} as unknown as PresentationSessionApi

	await act(async () => {
		root.render(
			<PresentationTextEditor
				session={session}
				shape={SHAPE}
				scale={1}
				editing={editing}
				labels={{ editor: "Slide text" }}
				apple={false}
				measurer={new FakeMeasurer()}
				bindings={bindings}
				onExit={() => undefined}
				onRefused={() => undefined}
			/>
		)
	})
	await flushAll()

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
