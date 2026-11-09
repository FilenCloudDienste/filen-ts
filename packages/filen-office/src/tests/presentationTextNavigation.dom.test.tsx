// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { EditorState, TextSelection } from "prosemirror-state"
import { afterEach, describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import { moveParagraphs } from "../core/presentation/edit/commands/text"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { SlideRender, TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { bodyToDoc, presentationTextSchema } from "../core/presentation/text/schema"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { PresentationTextEditor } from "../react/presentation/edit/text/TextEditor"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import { APPLE_TEXT_BINDINGS, DEFAULT_TEXT_BINDINGS, defaultTextBindings, textKeyCommand } from "../react/presentation/edit/text/keys"
import { cellStep, placeholderNavigation, type TextNavigation } from "../react/presentation/edit/text/navigate"
import { FakeMeasurer, testFont } from "./textFixtures"

// The keys that leave a body for another one or rework its paragraphs, as PowerPoint's: Enter on a shape opens it
// with its text selected; in a table cell Tab, Shift+Tab and Up/Down at the cell's edge go to another cell (Tab in the
// last one adds a row), Ctrl+Tab types a tab; Alt+Shift+arrows promote, demote and move paragraphs; Ctrl+Enter goes
// to the next placeholder (a new slide after the last one).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SLIDE = slideRef(7)
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }

function bodyOf(texts: readonly string[]): TextBody {
	return { bodyPr: {}, paragraphs: texts.map(text => ({ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] })) }
}

function laid(body: TextBody) {
	const result = layoutBody(
		resolveBody(body, { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }),
		{ width: 300, height: 100 },
		ENV
	)

	return { page: result.page, layout: transferableLayout(result) }
}

function seedOf(shape: ShapeRef, texts: readonly string[]): TextSeed {
	const body = bodyOf(texts)

	return {
		shape,
		revision: 1,
		body,
		resolved: texts.map(() => ({ pPr: {}, runs: [{}] })),
		...laid(body),
		matrix: [1, 0, 0, 1, 40, 50]
	}
}

// A 2 × 2 table frame (id 5), its second row's cells merged, and two placeholders (ids 2 and 3) on the slide.
const RENDER = {
	ref: SLIDE,
	index: 0,
	revision: 1,
	hidden: false,
	layers: [
		{ shape: { slide: SLIDE, id: 2 }, role: "placeholder", matrix: [1, 0, 0, 1, 0, 0], box: { id: 2, body: "placeholder" } },
		{
			shape: { slide: SLIDE, id: 5 },
			role: "table",
			matrix: [1, 0, 0, 1, 0, 0],
			box: { id: 5, body: "table" },
			table: { columnEdges: [0, 50, 100], rowEdges: [0, 20, 40], areas: Int32Array.from([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 2]) }
		},
		{ shape: { slide: SLIDE, id: 3 }, role: "placeholder", matrix: [1, 0, 0, 1, 0, 0], box: { id: 3, body: "placeholder" } }
	],
	notesText: "",
	animated: false
} as unknown as SlideRender

async function flushAll(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

function key(target: Element, init: KeyboardEventInit): void {
	target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
}

async function mount(options: {
	readonly shape: ShapeRef
	readonly texts?: readonly string[]
	readonly selectAll?: boolean
	readonly apple?: boolean
	readonly typed?: string
}) {
	const ops: DeckOp[] = []
	const navigated: TextNavigation[] = []
	const frame = document.createElement("div")

	frame.className = "fo-slide-frame"
	document.body.append(frame)

	const editing = createTextEditing()
	const root = createRoot(frame)
	const texts = options.texts ?? ["Hello"]
	const session = {
		textSeed: () => Promise.resolve(seedOf(options.shape, texts)),
		layoutText: (_shape: ShapeRef, body: TextBody) => Promise.resolve({ ...laid(body), revision: 2 }),
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length + 1, dirty: true })
		}
	} as unknown as PresentationSessionApi

	if (options.typed !== undefined) editing.expect({ typed: options.typed })

	await act(async () => {
		root.render(
			<PresentationTextEditor
				session={session}
				shape={options.shape}
				scale={1}
				editing={editing}
				labels={{ editor: "Slide text" }}
				render={RENDER}
				apple={options.apple ?? false}
				measurer={new FakeMeasurer()}
				{...(options.selectAll === true ? { selectAll: true } : {})}
				onExit={() => undefined}
				onNavigate={to => navigated.push(to)}
				onRefused={() => undefined}
			/>
		)
	})
	await flushAll()

	const sink = frame.querySelector(".fo-text-sink.ProseMirror") as HTMLElement

	return { editing, root, ops, navigated, sink }
}

function paragraphs(doc: { forEach: (f: (node: { textContent: string; attrs: Record<string, unknown> }) => void) => void }) {
	const out: { text: string; lvl: number }[] = []

	doc.forEach(node => out.push({ text: node.textContent, lvl: (node.attrs["pPr"] as { lvl?: number } | undefined)?.lvl ?? 0 }))

	return out
}

afterEach(() => {
	document.body.replaceChildren()
})

describe("Enter on a shape selected as an object", () => {
	it("opens the body with its whole text selected, and text typed ahead replaces it", async () => {
		const { editing, root } = await mount({ shape: { slide: SLIDE, id: 2 }, texts: ["Hello", "world"], selectAll: true })
		const state = editing.active?.state

		expect(state?.selection.from).toBe(0)
		expect(state?.selection.to).toBe(state?.doc.content.size)

		await act(async () => {
			root.unmount()
		})

		const typed = await mount({ shape: { slide: SLIDE, id: 2 }, texts: ["Hello", "world"], selectAll: true, typed: "X" })

		expect(paragraphs(typed.editing.active?.state.doc as never).map(each => each.text)).toEqual(["X"])

		await act(async () => {
			typed.root.unmount()
		})
	})

	it("without it (F2, a click) the caret is not over the text", async () => {
		const { editing, root } = await mount({ shape: { slide: SLIDE, id: 2 }, texts: ["Hello"] })

		expect(editing.active?.state.selection.empty).toBe(true)

		await act(async () => {
			root.unmount()
		})
	})
})

describe("table cell keys", () => {
	it("steps through merged areas in reading order, adding a row past the last cell", () => {
		const areas = [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 2]

		expect(cellStep(areas, 2, { row: 0, col: 0 }, "next")).toEqual({ row: 0, col: 1 })
		expect(cellStep(areas, 2, { row: 0, col: 1 }, "next")).toEqual({ row: 1, col: 0 })
		expect(cellStep(areas, 2, { row: 1, col: 0 }, "next")).toBe("addRow")
		expect(cellStep(areas, 2, { row: 1, col: 0 }, "previous")).toEqual({ row: 0, col: 1 })
		expect(cellStep(areas, 2, { row: 0, col: 0 }, "previous")).toBeUndefined()
		expect(cellStep(areas, 2, { row: 0, col: 1 }, "down")).toEqual({ row: 1, col: 0 })
		expect(cellStep(areas, 2, { row: 1, col: 0 }, "down")).toBeUndefined()
		expect(cellStep(areas, 2, { row: 1, col: 0 }, "up")).toEqual({ row: 0, col: 0 })
		expect(cellStep(areas, 2, { row: 0, col: 1 }, "up")).toBeUndefined()
	})

	it("Tab and Shift+Tab open the next and previous cell, Tab in the last cell adds a row, Ctrl+Tab types a tab", async () => {
		const table = { slide: SLIDE, id: 5 }
		const first = await mount({ shape: { ...table, cell: { row: 0, col: 1 } } })

		key(first.sink, { key: "Tab", code: "Tab" })
		await flushAll()
		key(first.sink, { key: "Tab", code: "Tab", ctrlKey: true })
		await flushAll()

		expect(first.navigated).toEqual([{ kind: "open", shape: { ...table, cell: { row: 1, col: 0 } } }])

		await act(async () => {
			first.root.unmount()
		})

		const last = await mount({ shape: { ...table, cell: { row: 1, col: 0 } } })

		key(last.sink, { key: "Tab", code: "Tab", ctrlKey: true })
		expect(last.editing.active?.state.doc.textContent).toBe("Hello\t")

		key(last.sink, { key: "Tab", code: "Tab", shiftKey: true })
		key(last.sink, { key: "Tab", code: "Tab" })
		await flushAll()

		expect(last.navigated).toEqual([
			{ kind: "open", shape: { ...table, cell: { row: 0, col: 1 } } },
			{ kind: "addRow", table, at: 2, shape: { ...table, cell: { row: 2, col: 0 } } }
		])

		await act(async () => {
			last.root.unmount()
		})
	})

	it("Down on a cell's last line opens the cell below; on the last row it stays", async () => {
		const table = { slide: SLIDE, id: 5 }
		const top = await mount({ shape: { ...table, cell: { row: 0, col: 1 } } })

		key(top.sink, { key: "ArrowDown", code: "ArrowDown" })
		await flushAll()
		expect(top.navigated).toEqual([{ kind: "open", shape: { ...table, cell: { row: 1, col: 0 } } }])

		await act(async () => {
			top.root.unmount()
		})

		const bottom = await mount({ shape: { ...table, cell: { row: 1, col: 0 } } })

		key(bottom.sink, { key: "ArrowDown", code: "ArrowDown" })
		await flushAll()
		expect(bottom.navigated).toEqual([])

		await act(async () => {
			bottom.root.unmount()
		})
	})

	it("outside a table Tab still changes the level", async () => {
		const { editing, root, navigated, sink } = await mount({ shape: { slide: SLIDE, id: 2 } })

		editing.active?.setSelection(1, 1)
		key(sink, { key: "Tab", code: "Tab" })

		expect(navigated).toEqual([])
		expect(paragraphs(editing.active?.state.doc as never)[0]?.lvl).toBe(1)

		await act(async () => {
			root.unmount()
		})
	})
})

describe("paragraph keys", () => {
	it("Alt+Shift+Right and Left demote and promote the paragraph", async () => {
		const { editing, root, sink } = await mount({ shape: { slide: SLIDE, id: 2 }, texts: ["One", "Two"] })

		editing.active?.setSelection(7, 7)
		key(sink, { key: "ArrowRight", code: "ArrowRight", altKey: true, shiftKey: true })
		expect(paragraphs(editing.active?.state.doc as never).map(each => each.lvl)).toEqual([0, 1])
		expect(editing.active?.state.selection.empty).toBe(true)

		key(sink, { key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true })
		expect(paragraphs(editing.active?.state.doc as never).map(each => each.lvl)).toEqual([0, 0])

		await act(async () => {
			root.unmount()
		})
	})

	it("Alt+Shift+Up and Down move the paragraph, the caret with it", async () => {
		const { editing, root, sink } = await mount({ shape: { slide: SLIDE, id: 2 }, texts: ["One", "Two", "Three"] })

		editing.active?.setSelection(7, 7)
		key(sink, { key: "ArrowUp", code: "ArrowUp", altKey: true, shiftKey: true })
		expect(paragraphs(editing.active?.state.doc as never).map(each => each.text)).toEqual(["Two", "One", "Three"])
		expect(editing.active?.state.selection.head).toBe(2)

		key(sink, { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true })
		key(sink, { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true })
		expect(paragraphs(editing.active?.state.doc as never).map(each => each.text)).toEqual(["One", "Three", "Two"])

		await act(async () => {
			root.unmount()
		})
	})

	it("moves several selected paragraphs as one block and stops at the body's edge", () => {
		const { doc } = bodyToDoc(bodyOf(["A", "B", "C", "D"]))
		const state = EditorState.create({ doc, schema: presentationTextSchema })
		const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4, 7)))
		let next = selected

		expect(moveParagraphs(-1)(selected, tr => (next = selected.apply(tr)))).toBe(true)
		expect(paragraphs(next.doc as never).map(each => each.text)).toEqual(["B", "C", "A", "D"])
		expect([next.selection.from, next.selection.to]).toEqual([1, 4])
		expect(moveParagraphs(-1)(next)).toBe(false)
	})

	it("Ctrl+Enter opens the next placeholder in z-order, past the last one a new slide", async () => {
		const title = await mount({ shape: { slide: SLIDE, id: 2 } })

		key(title.sink, { key: "Enter", code: "Enter", ctrlKey: true })
		await flushAll()
		expect(title.navigated).toEqual([{ kind: "open", shape: { slide: SLIDE, id: 3 } }])
		expect(paragraphs(title.editing.active?.state.doc as never).length).toBe(1)

		await act(async () => {
			title.root.unmount()
		})

		expect(placeholderNavigation(RENDER, { slide: SLIDE, id: 3 })).toEqual({ kind: "addSlide" })
		// A table cell goes to the placeholder after its frame.
		expect(placeholderNavigation(RENDER, { slide: SLIDE, id: 5, cell: { row: 0, col: 0 } })).toEqual({
			kind: "open",
			shape: { slide: SLIDE, id: 3 }
		})
	})

	it("binds the Mac's own keys there: Cmd+[ and Cmd+] promote and demote, nothing for the Windows-only ones", async () => {
		expect(defaultTextBindings(true)).toBe(APPLE_TEXT_BINDINGS)
		expect(defaultTextBindings(false)).toBe(DEFAULT_TEXT_BINDINGS)

		const keyOf = (init: Partial<KeyboardEvent>) => ({
			key: "",
			code: "",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			altKey: false,
			...init
		})

		expect(textKeyCommand(keyOf({ key: "]", code: "BracketRight", metaKey: true }), APPLE_TEXT_BINDINGS, true)).toBe("demote")
		expect(textKeyCommand(keyOf({ key: "ArrowUp", code: "ArrowUp", altKey: true, shiftKey: true }), APPLE_TEXT_BINDINGS, true)).toBe(
			undefined
		)

		const { editing, root, sink } = await mount({ shape: { slide: SLIDE, id: 2 }, apple: true })

		editing.active?.setSelection(3, 3)
		key(sink, { key: "]", code: "BracketRight", metaKey: true })
		expect(paragraphs(editing.active?.state.doc as never)[0]?.lvl).toBe(1)

		await act(async () => {
			root.unmount()
		})
	})
})
