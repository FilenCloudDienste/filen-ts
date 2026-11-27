import { describe, expect, it } from "vitest"
import { EditorSelection, EditorState } from "@codemirror/state"
import { ensureSyntaxTree } from "@codemirror/language"
import { history, undo, undoDepth } from "@codemirror/commands"
import type { Decoration } from "@codemirror/view"
import { codeLanguageSupport } from "@filen/office/dom/code"
import { buildLivePreview, type LivePreviewConfig } from "@/features/preview/lib/livePreview/decorations"
import { BULLET, CheckboxWidget, EmbedWidget, FenceLabelWidget, ImageWidget, TableWidget } from "@/features/preview/lib/livePreview/widgets"
import { linkAt, toggleTask } from "@/features/preview/lib/livePreview/commands"
import { previewImageSource } from "@/features/preview/components/markdownViewer.logic"

// The live preview's decorations, read from the markdown syntax tree: each element styled in place, its syntax hidden
// (or drawn as a widget) except where the selection touches it, and only within the stretch asked for.

const renderMath = (): (() => void) => () => undefined
const renderMermaid = (): (() => void) => () => undefined

const CONFIG: LivePreviewConfig = {
	image: previewImageSource,
	openLink: () => undefined,
	labels: { imageNotLoaded: alt => `not loaded: ${alt}`, task: "Toggle task", openLink: "Ctrl+click to open" },
	math: renderMath,
	mermaid: renderMermaid
}

const MARKDOWN = codeLanguageSupport("markdown")

function stateOf(doc: string, cursor?: number): EditorState {
	const state = EditorState.create({
		doc,
		extensions: [MARKDOWN, history()],
		...(cursor === undefined ? {} : { selection: EditorSelection.cursor(cursor) })
	})

	ensureSyntaxTree(state, state.doc.length, 5000)

	// A transaction picks up the tree the parse reached.
	return state.update({}).state
}

// What a test reads of a decoration's spec (CodeMirror types it any).
interface Spec {
	readonly widget?: unknown
	readonly class?: unknown
	readonly attributes?: unknown
}

function specOf(decoration: Decoration): Spec {
	return decoration.spec as Spec
}

interface Found {
	readonly from: number
	readonly to: number
	readonly spec: Spec
}

function decorate(doc: string, options?: { cursor?: number; from?: number; to?: number; config?: LivePreviewConfig }) {
	const state = stateOf(doc, options?.cursor)
	const built = buildLivePreview(
		state,
		options?.from ?? 0,
		options?.to ?? state.doc.length,
		options?.cursor !== undefined,
		options?.config ?? CONFIG
	)
	const found: Found[] = []

	built.decorations.between(0, state.doc.length, (from, to, decoration) => {
		found.push({ from, to, spec: specOf(decoration) })
	})

	return { state, found, blocks: built.blocks }
}

function hidden(found: readonly Found[]): [number, number][] {
	return found
		.filter(({ spec, from, to }) => to > from && spec.widget === undefined && spec.class === undefined)
		.filter(({ spec }) => spec.attributes === undefined)
		.map(({ from, to }) => [from, to])
}

function classesAt(found: readonly Found[], pos: number): string[] {
	return found
		.filter(({ from, to, spec }) => from === pos && to === pos && typeof spec.class === "string")
		.map(({ spec }) => String(spec.class))
}

function marks(found: readonly Found[], className: string): [number, number][] {
	return found.filter(({ from, to, spec }) => to > from && spec.class === className).map(({ from, to }) => [from, to])
}

function widgets<T>(found: readonly Found[], type: abstract new (...args: never[]) => T): { from: number; to: number; widget: T }[] {
	return found.flatMap(({ from, to, spec }) => {
		const widget = spec.widget

		return widget instanceof type ? [{ from, to, widget }] : []
	})
}

describe("live preview decorations", () => {
	it("sizes a heading and hides its marks until the cursor is on its line", () => {
		const doc = "# Title\n\ntext"

		expect(classesAt(decorate(doc).found, 0)).toEqual(["cm-lp-heading cm-lp-h1"])
		expect(hidden(decorate(doc).found)).toEqual([[0, 2]])
		expect(hidden(decorate(doc, { cursor: 4 }).found)).toEqual([])
		// Elsewhere in the document: hidden again.
		expect(hidden(decorate(doc, { cursor: doc.length }).found)).toEqual([[0, 2]])
	})

	it("styles bold, italic, strikethrough and inline code, showing their marks only where the cursor touches", () => {
		const doc = "a **b** _c_ ~~d~~ `e`"
		const { found } = decorate(doc)

		expect(marks(found, "cm-lp-strong")).toEqual([[2, 7]])
		expect(marks(found, "cm-lp-em")).toEqual([[8, 11]])
		expect(marks(found, "cm-lp-strike")).toEqual([[12, 17]])
		expect(marks(found, "cm-lp-code")).toEqual([[19, 20]])
		expect(hidden(found)).toEqual([
			[2, 4],
			[5, 7],
			[8, 9],
			[10, 11],
			[12, 14],
			[15, 17],
			[18, 19],
			[20, 21]
		])
		// In the bold span: its marks show, the others stay hidden.
		expect(hidden(decorate(doc, { cursor: 4 }).found)).toEqual([
			[8, 9],
			[10, 11],
			[12, 14],
			[15, 17],
			[18, 19],
			[20, 21]
		])
	})

	it("draws a link as its text and finds its URL", () => {
		const doc = "see [docs](https://filen.io/docs) and <https://a.example> or https://b.example"
		const { found, state } = decorate(doc)

		expect(marks(found, "cm-lp-link")).toContainEqual([5, 9])
		expect(hidden(found)).toContainEqual([4, 5])
		expect(hidden(found)).toContainEqual([9, 33])
		expect(linkAt(state, 6)).toBe("https://filen.io/docs")
		expect(linkAt(state, doc.indexOf("a.example"))).toBe("https://a.example")
		expect(linkAt(state, doc.indexOf("b.example"))).toBe("https://b.example")
		expect(linkAt(state, 1)).toBeNull()
		expect(hidden(decorate(doc, { cursor: 6 }).found)).not.toContainEqual([9, 33])
	})

	it("resolves a reference link through its definition", () => {
		const state = stateOf("[docs][ref]\n\n[ref]: https://filen.io")

		expect(linkAt(state, 2)).toBe("https://filen.io")
	})

	it("shows an image under the host's policy, its source where the cursor is", () => {
		const data = "![dot](data:image/png;base64,AA)"
		const remote = "![logo](https://example.com/logo.png)"

		expect(widgets(decorate(data).found, ImageWidget).map(({ widget }) => widget.src)).toEqual(["data:image/png;base64,AA"])
		expect(widgets(decorate(remote).found, ImageWidget).map(({ widget }) => [widget.src, widget.missing])).toEqual([
			[null, "not loaded: logo"]
		])
		expect(widgets(decorate(remote, { cursor: 3 }).found, ImageWidget)).toEqual([])
	})

	it("draws bullets, keeps numbers and turns task markers into boxes", () => {
		const doc = "- one\n1. two\n- [ ] three\n- [x] four"
		const { found } = decorate(doc)

		expect(found.filter(({ spec }) => spec.widget === BULLET).map(({ from, to }) => [from, to])).toEqual([[0, 1]])
		expect(marks(found, "cm-lp-list-number")).toEqual([[6, 8]])
		expect(widgets(found, CheckboxWidget).map(({ widget, from }) => [from, widget.checked])).toEqual([
			[15, false],
			[27, true]
		])
		// The "- " before a box is hidden with it.
		expect(hidden(found)).toContainEqual([13, 15])
	})

	it("toggles a task as one undo step of its own", () => {
		let state = stateOf("- [ ] task")

		state = state.update({ changes: { from: state.doc.length, insert: "s" }, userEvent: "input.type" }).state

		const spec = toggleTask(state, 2)

		expect(spec).not.toBeNull()

		if (spec === null) {
			return
		}

		state = state.update(spec).state

		expect(state.doc.toString()).toBe("- [x] tasks")
		expect(undoDepth(state)).toBe(2)

		let undone = state

		undo({
			state,
			dispatch: tr => {
				undone = tr.state
			}
		})

		expect(undone.doc.toString()).toBe("- [ ] tasks")
		expect(toggleTask(state, 0)).toBeNull()
	})

	it("disables the box of a read-only document", () => {
		const state = EditorState.create({ doc: "- [ ] a", extensions: [MARKDOWN, EditorState.readOnly.of(true)] })

		ensureSyntaxTree(state, state.doc.length, 5000)

		const built = buildLivePreview(state, 0, state.doc.length, false, CONFIG)
		const boxes: CheckboxWidget[] = []

		built.decorations.between(0, state.doc.length, (_from, _to, decoration) => {
			const widget = specOf(decoration).widget

			if (widget instanceof CheckboxWidget) {
				boxes.push(widget)
			}
		})

		expect(boxes.map(box => box.readOnly)).toEqual([true])
	})

	it("draws blockquotes and rules", () => {
		const doc = "> quoted\n\n---\n\nafter"
		const { found } = decorate(doc)

		expect(classesAt(found, 0)).toEqual(["cm-lp-quote"])
		expect(classesAt(found, 10)).toEqual(["cm-lp-hr"])
		expect(hidden(found)).toEqual([
			[0, 2],
			[10, 13]
		])
	})

	it("renders a table as a grid, and as its source once the cursor enters", () => {
		const doc = "| a | **b** |\n| :-- | --: |\n| 1 | |\n\nafter"
		const { found, blocks } = decorate(doc)
		const tables = widgets(found, TableWidget)
		const table = tables[0]?.widget

		expect(tables.map(({ from, to }) => [from, to])).toEqual([[0, 35]])
		expect(blocks).toEqual([{ from: 0, to: 35 }])
		expect(table?.model.align).toEqual(["left", "right"])
		expect(table?.model.header.map(cell => cell.map(run => [run.text, run.strong]))).toEqual([[["a", false]], [["b", true]]])
		expect(table?.model.rows.map(row => row.map(cell => cell.map(run => run.text).join("")))).toEqual([["1", ""]])

		const inside = decorate(doc, { cursor: 3 })

		expect(widgets(inside.found, TableWidget)).toEqual([])
		expect(classesAt(inside.found, 0)).toEqual(["cm-lp-table-source"])
	})

	it("keeps a fence's code, its fences shown as its language until the cursor enters", () => {
		const doc = "```ts\nconst a = 1\n```\n\nafter"
		const { found } = decorate(doc)

		expect(classesAt(found, 0)).toEqual(["cm-lp-fence", "cm-lp-fence-start"])
		expect(classesAt(found, 6)).toEqual(["cm-lp-fence"])
		expect(widgets(found, FenceLabelWidget).map(({ widget, from, to }) => [widget.language, from, to])).toEqual([["ts", 0, 5]])
		expect(hidden(found)).toEqual([[18, 21]])
		expect(widgets(decorate(doc, { cursor: 8 }).found, FenceLabelWidget)).toEqual([])
	})

	it("draws a mermaid fence and formulas where the host renders them", () => {
		const doc = "```mermaid\ngraph TD; A-->B\n```\n\nprice $5 and $10, area $x^2$\n\n$$\na+b\n$$"
		const { found, blocks } = decorate(doc)
		const embeds = widgets(found, EmbedWidget).map(({ widget }) => [widget.source, widget.display, widget.render === renderMermaid])

		expect(embeds).toEqual([
			["graph TD; A-->B", true, true],
			["x^2", false, false],
			["a+b", true, false]
		])
		expect(blocks.length).toBe(2)

		const plain = decorate(doc, { config: { ...CONFIG, math: null, mermaid: null } })

		expect(widgets(plain.found, EmbedWidget)).toEqual([])
	})

	it("draws a ```math fence as display math, its source shown while the cursor is in it", () => {
		const doc = "```math\nx = 1\ny = 2\n```\n\n~~~Math\nz\n~~~"
		const { found, blocks } = decorate(doc)
		const embeds = widgets(found, EmbedWidget).map(({ widget }) => [widget.source, widget.display, widget.render === renderMath])

		expect(embeds).toEqual([
			["x = 1\ny = 2", true, true],
			["z", true, true]
		])
		expect(blocks.length).toBe(2)
		expect(widgets(found, FenceLabelWidget)).toEqual([])

		const editing = decorate(doc, { cursor: 9 })

		expect(widgets(editing.found, EmbedWidget).map(({ widget }) => widget.source)).toEqual(["z"])
		expect(classesAt(editing.found, 0)).toEqual(["cm-lp-fence", "cm-lp-fence-start"])

		// Without math, a code block like any other.
		const plain = decorate(doc, { config: { ...CONFIG, math: null } })

		expect(widgets(plain.found, EmbedWidget)).toEqual([])
		expect(widgets(plain.found, FenceLabelWidget).map(({ widget }) => widget.language)).toEqual(["math", "Math"])
	})

	it("decorates only the stretch asked for", () => {
		const doc = Array.from({ length: 2000 }, (_, index) => `# Heading ${String(index)}`).join("\n")
		const state = stateOf(doc)
		const from = state.doc.line(1000).from
		const to = state.doc.line(1010).to
		const built = buildLivePreview(state, from, to, false, CONFIG)
		const lines = new Set<number>()

		built.decorations.between(0, state.doc.length, pos => {
			lines.add(state.doc.lineAt(pos).number)
		})

		expect([...lines].sort((a, b) => a - b)).toEqual(Array.from({ length: 11 }, (_, index) => 1000 + index))
	})
})
