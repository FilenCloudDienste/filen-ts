// @vitest-environment happy-dom
import { Node as ProseMirrorNode } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { describe, expect, it, vi } from "vitest"
import { DocxMediaCache, type DocxDocument } from "@filen/office/react/docx"
import { EditSink } from "../react/docx/edit/sink"
import { ReflowView } from "../react/docx/reflow/view"
import { buildDocx, p } from "./docxSynthetic"
import { emptyDocxSession } from "./docxDocumentStubs.dom"
import { pagedEditor } from "./pagedDomFixtures"
import { budget, cpuMs } from "./timing"

// Mobile view over a long document: what opening it holds (DOM, blocks in the view) does not grow with the
// document, and a keystroke stays under a frame (CPU time, which other processes' scheduling does not inflate).

const SESSION = emptyDocxSession()

const DOCUMENT: DocxDocument = {
	status: "ready",
	info: undefined,
	pages: [],
	pageCount: 0,
	tables: { styles: [], decorations: [], links: [] },
	session: SESSION,
	media: new DocxMediaCache(SESSION),
	error: undefined
}

// About ten paragraphs of 420 characters a page.
function long(pages: number): Uint8Array {
	return buildDocx({
		body: Array.from({ length: pages * 10 }, (_, k) =>
			p(`Paragraph ${String(k)} ${"lorem ipsum dolor sit amet consectetur ".repeat(10)}`)
		).join("")
	})
}

function percentile(values: readonly number[], share: number): number {
	const sorted = [...values].sort((a, b) => a - b)

	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0
}

async function opened(pages: number): Promise<{ elements: number; blocks: number; openMs: number; keystrokes: number[]; editor: number }> {
	const { editor } = await pagedEditor(long(pages))
	const session = editor.body.session
	const middle = session.state.doc.child(0).nodeSize * Math.floor(session.state.doc.childCount / 2) + 20

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, middle)))
	editor.suspend()

	const scroller = document.createElement("div")

	document.body.appendChild(scroller)

	const start = cpuMs()
	const reflow = new ReflowView(editor, scroller, {
		label: "Document",
		readOnly: false,
		apple: false,
		onFind: undefined,
		marks: [],
		interactions: undefined,
		document: DOCUMENT
	})
	const openMs = cpuMs() - start
	const view = reflow.main.view
	const keystrokes: number[] = []

	for (let k = 0; k < 300; k++) {
		const before = cpuMs()

		if (k % 50 === 49) view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
		else view.dispatch(view.state.tr.insertText("a"))

		keystrokes.push(cpuMs() - before)
	}

	const result = {
		elements: scroller.querySelectorAll("*").length,
		blocks: view.state.doc.childCount,
		openMs,
		keystrokes,
		editor: session.state.doc.childCount
	}

	reflow.destroy()
	scroller.remove()
	editor.resume()
	editor.dispose()

	return result
}

describe("Mobile view performance", () => {
	it("opens a 300-page document holding a window of it and types under a frame per keystroke", { timeout: 300_000 }, async () => {
		const small = await opened(30)
		const large = await opened(300)
		const p50 = percentile(large.keystrokes, 0.5)
		const p95 = percentile(large.keystrokes, 0.95)

		console.info(
			`Mobile view 300p (${String(large.editor)} blocks): open ${large.openMs.toFixed(1)} ms, ${String(large.elements)} elements, ` +
				`${String(large.blocks)} view blocks (30p: ${small.openMs.toFixed(1)} ms, ${String(small.elements)} elements); ` +
				`keystroke p50 ${p50.toFixed(2)} ms p95 ${p95.toFixed(2)} ms`
		)

		expect(large.editor).toBeGreaterThan(3000)
		// The DOM and the view's blocks hold a window: the same for 30 pages as for 300.
		expect(large.elements).toBeLessThan(small.elements * 1.5 + 50)
		expect(large.blocks).toBeLessThan(80)
		expect(large.openMs).toBeLessThan(Math.max(budget(250), small.openMs * 4))
		expect(p95).toBeLessThan(budget(16))
	})

	it(
		"holds a window of a long table's rows, in Mobile view and in the input view, and types under a frame in it",
		{ timeout: 120_000 },
		async () => {
			const rows = Array.from(
				{ length: 3000 },
				(_, k) =>
					`<w:tr><w:tc><w:p><w:r><w:t>r${String(k)}a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>r${String(k)}b</w:t></w:r></w:p></w:tc></w:tr>`
			).join("")
			const { editor } = await pagedEditor(
				buildDocx({
					body:
						p("Before") +
						`<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>` +
						p("After")
				})
			)
			const session = editor.body.session
			// A cell in the middle of the table.
			let target = -1

			session.state.doc.descendants((node, pos) => {
				if (node.isText && node.text === "r1500a") target = pos + 2

				return target < 0
			})
			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, target)))
			editor.suspend()

			const scroller = document.createElement("div")

			document.body.appendChild(scroller)

			const reflow = new ReflowView(editor, scroller, {
				label: "Document",
				readOnly: false,
				apple: false,
				onFind: undefined,
				marks: [],
				interactions: undefined,
				document: DOCUMENT
			})
			const view = reflow.main.view
			const times: number[] = []

			for (let k = 0; k < 100; k++) {
				const before = cpuMs()

				view.dispatch(view.state.tr.insertText("a"))
				times.push(cpuMs() - before)
			}

			const elements = scroller.querySelectorAll("*").length

			reflow.destroy()
			scroller.remove()
			console.info(
				`Mobile view, 3000-row table: ${String(elements)} elements, keystroke p95 ${percentile(times, 0.95).toFixed(2)} ms`
			)

			expect(session.state.doc.textContent).toContain(`r1${"a".repeat(100)}500a`)
			expect(elements).toBeLessThan(1000)
			expect(percentile(times, 0.95)).toBeLessThan(budget(16))

			// The input view holds rows around the selection only.
			const host = document.createElement("div")

			document.body.appendChild(host)

			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

			expect(host.querySelectorAll("tr").length).toBeLessThan(100)
			sink.view.dispatch(sink.view.state.tr.insertText("b"))
			expect(session.state.doc.textContent).toContain(`r1${"a".repeat(100)}b500a`)
			sink.destroy()
			host.remove()
			editor.resume()
		}
	)

	it("reads the blocks a keystroke touched, not the document's (beyond what the pages' input view reads)", async () => {
		const { editor } = await pagedEditor(long(300))
		const session = editor.body.session
		const child = vi.spyOn(ProseMirrorNode.prototype, "child")
		// Blocks read for a keystroke and an Enter through `view`.
		const reads = (view: EditorView): [number, number] => {
			child.mockClear()
			view.dispatch(view.state.tr.insertText("a"))

			const typed = child.mock.calls.length

			child.mockClear()
			view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))

			return [typed, child.mock.calls.length]
		}

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 5)))
		editor.suspend()

		const host = document.createElement("div")

		document.body.appendChild(host)

		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const [sinkTyped, sinkSplit] = reads(sink.view)

		sink.destroy()
		host.remove()

		const scroller = document.createElement("div")

		document.body.appendChild(scroller)

		const reflow = new ReflowView(editor, scroller, {
			label: "Document",
			readOnly: false,
			apple: false,
			onFind: undefined,
			marks: [],
			interactions: undefined,
			document: DOCUMENT
		})
		const [typed, split] = reads(reflow.main.view)

		child.mockRestore()
		reflow.destroy()
		scroller.remove()
		editor.resume()

		expect(session.state.doc.childCount).toBe(3002)
		expect(typed - sinkTyped).toBeLessThan(400)
		expect(split - sinkSplit).toBeLessThan(400)
	})
})
