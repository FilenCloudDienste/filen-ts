// @vitest-environment happy-dom
import { TextSelection } from "prosemirror-state"
import type { Node } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import { afterEach, describe, expect, it } from "vitest"
import { RevisionFlag, RevisionView, revisionHidden } from "../core/docx/model/kinds"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { EditSink } from "@filen/office/react/docx/editor"
import { ReflowView, type ReflowViewOptions } from "../react/docx/reflow/view"
import { emptyDocxDocument } from "./docxDocumentStubs.dom"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// Tab as Word has it, in the paged editor's input view and in Mobile view alike.

interface Surface {
	readonly view: EditorView
	destroy(): void
}

interface SurfaceOptions {
	readonly readOnly?: boolean
	readonly apple?: boolean
	readonly describedBy?: string
}

const cleanups: (() => void)[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

const SURFACES: readonly { readonly name: string; open(editor: PagedEditor, options?: SurfaceOptions): Surface }[] = [
	{
		name: "the pages' input view",
		open(editor, options = {}) {
			const host = document.createElement("div")

			document.body.appendChild(host)

			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined, ...options })
			const surface = {
				view: sink.view,
				destroy: () => {
					sink.destroy()
					host.remove()
				}
			}

			cleanups.push(surface.destroy)

			return surface
		}
	},
	{
		name: "Mobile view",
		open(editor, options = {}) {
			const scroller = document.createElement("div")

			scroller.className = "fo-docx-reflow"
			document.body.appendChild(scroller)

			const reflowOptions: ReflowViewOptions = {
				label: "Document",
				describedBy: options.describedBy,
				readOnly: options.readOnly === true,
				apple: options.apple === true,
				onFind: undefined,
				marks: [],
				interactions: undefined,
				document: emptyDocxDocument()
			}
			const reflow = new ReflowView(editor, scroller, reflowOptions)
			const surface = {
				view: reflow.main.view,
				destroy: () => {
					reflow.destroy()
					scroller.remove()
				}
			}

			cleanups.push(surface.destroy)

			return surface
		}
	}
]

// Presses a key in the view: whether it was taken (its default prevented).
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })

	view.dom.dispatchEvent(event)

	return event.defaultPrevented
}

// The position of the first occurrence of `text` in `doc` (+ `offset`).
function textPos(doc: Node, text: string, offset = 0): number {
	let found = -1

	doc.descendants((node, pos) => {
		if (found < 0 && node.isText && node.text?.includes(text) === true) found = pos + (node.text?.indexOf(text) ?? 0)

		return found < 0
	})

	if (found < 0) throw new Error(`no ${text}`)

	return found + offset
}

function select(editor: PagedEditor, anchor: number, head = anchor): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, anchor, head)))
}

function selectedText(editor: PagedEditor): string {
	const { from, to } = editor.session.state.selection

	return editor.session.state.doc.textBetween(from, to, "\n", "\t")
}

function tabsIn(node: Node): number {
	let count = 0

	node.descendants(child => {
		if (child.type.name === "tab") count++
	})

	return count
}

function firstTable(editor: PagedEditor): Node {
	let table: Node | undefined

	editor.body.session.state.doc.forEach(node => {
		if (table === undefined && node.type.name === "table") table = node
	})

	if (table === undefined) throw new Error("no table")

	return table
}

const cell = (text: string, tcPr = ""): string =>
	`<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}<w:p>${text === "" ? "" : `<w:r><w:t>${text}</w:t></w:r>`}</w:p></w:tc>`
const table = (rows: readonly (readonly string[])[]): string =>
	`<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows.map(row => `<w:tr>${row.join("")}</w:tr>`).join("")}</w:tbl>`
const TABLE = buildDocx({
	body:
		p("Before") +
		table([
			[cell("a1"), cell("b1")],
			[cell("a2"), cell("b2")]
		]) +
		p("After")
})

for (const surface of SURFACES) {
	describe(`Tab in ${surface.name}`, () => {
		it("inserts a tab character in text, in place of a selection within a paragraph", async () => {
			const { editor } = await pagedEditor(buildDocx({ body: p("Hello world") }))
			const { view } = surface.open(editor)
			const doc = (): Node => editor.body.session.state.doc

			select(editor, textPos(doc(), "world"))
			expect(press(view, "Tab")).toBe(true)
			expect(tabsIn(doc())).toBe(1)
			expect(doc().textBetween(0, doc().content.size, "\n", "\t")).toBe("Hello \tworld")

			select(editor, textPos(doc(), "world"), textPos(doc(), "world", 5))
			expect(press(view, "Tab")).toBe(true)
			expect(doc().textBetween(0, doc().content.size, "\n", "\t")).toBe("Hello \t\t")

			// Shift+Tab outside a table or list does nothing, and focus stays.
			const before = doc()

			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(doc()).toBe(before)
		})

		it("moves to the next cell with its content selected, back with Shift+Tab, and stops at the first", async () => {
			const { editor } = await pagedEditor(TABLE)
			const { view } = surface.open(editor)
			const doc = editor.body.session.state.doc

			select(editor, textPos(doc, "a1", 1))
			expect(press(view, "Tab")).toBe(true)
			expect(selectedText(editor)).toBe("b1")
			// From a row's last cell to the next row's first.
			expect(press(view, "Tab")).toBe(true)
			expect(selectedText(editor)).toBe("a2")
			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(selectedText(editor)).toBe("b1")
			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(selectedText(editor)).toBe("a1")

			// Nothing before the first cell: the selection stays, focus too.
			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(selectedText(editor)).toBe("a1")
			// No content changed.
			expect(editor.body.session.state.doc).toBe(doc)
		})

		it("passes over a vertical merge's continuation and selects a cell of several paragraphs whole", async () => {
			const two = "<w:p><w:r><w:t>c1</w:t></w:r></w:p><w:p><w:r><w:t>c1b</w:t></w:r></w:p>"
			const { editor } = await pagedEditor(
				buildDocx({
					body: table([
						[cell("a1"), cell("b1", '<w:vMerge w:val="restart"/>')],
						[cell("a2"), cell("", "<w:vMerge/>")],
						[`<w:tc>${two}</w:tc>`, cell("b3")]
					])
				})
			)
			const { view } = surface.open(editor)

			select(editor, textPos(editor.body.session.state.doc, "a2"))
			expect(press(view, "Tab")).toBe(true)
			expect(selectedText(editor)).toBe("c1\nc1b")
			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(selectedText(editor)).toBe("a2")
		})

		it("adds a row from the last cell, a tracked insertion while tracking", async () => {
			for (const tracking of [false, true]) {
				const { editor } = await pagedEditor(TABLE)
				const { view } = surface.open(editor)

				if (tracking) {
					editor.body.session.context.review.tracking = true
					editor.body.session.context.identity.author = "Ann"
				}

				select(editor, textPos(editor.body.session.state.doc, "b2"), textPos(editor.body.session.state.doc, "b2", 2))
				expect(press(view, "Tab")).toBe(true)

				const rows = firstTable(editor)
				const added = rows.child(2)

				expect(rows.childCount).toBe(3)
				expect(added.textContent).toBe("")
				expect(((added.attrs["revision"] as number) & RevisionFlag.Inserted) !== 0).toBe(tracking)

				// The caret in the new row's first cell.
				const $head = editor.session.state.selection.$head

				expect(editor.session.state.selection.empty).toBe(true)
				expect($head.node($head.depth - 2)).toBe(added)
				expect($head.index($head.depth - 2)).toBe(0)
			}
		})

		it("passes over rows and cells the revision view hides, and adds a row below a hidden last row", async () => {
			const by = 'w:author="Ann" w:date="2024-01-01T00:00:00Z"'
			const trDel = `<w:trPr><w:del w:id="1" ${by}/></w:trPr>`
			const trIns = `<w:trPr><w:ins w:id="2" ${by}/></w:trPr>`
			const cellDel = `<w:cellDel w:id="3" ${by}/>`
			const doc = buildDocx({
				body:
					'<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
					`<w:tr>${cell("a1")}${cell("b1", cellDel)}</w:tr>` +
					`<w:tr>${trDel}${cell("a2")}${cell("b2")}</w:tr>` +
					`<w:tr>${trIns}${cell("a3")}${cell("b3")}</w:tr>` +
					`<w:tr>${cell("a4")}${cell("b4")}</w:tr>` +
					`<w:tr>${trDel}${cell("a5")}${cell("b5")}</w:tr></w:tbl>` +
					p("After")
			})
			const { editor } = await pagedEditor(doc)

			editor.setView(RevisionView.Final)

			const { view } = surface.open(editor)
			const at = (text: string): number => textPos(editor.body.session.state.doc, text, 1)

			// Final view: b1 (a deleted cell) and the deleted rows are not there.
			select(editor, at("a1"))
			expect(press(view, "Tab")).toBe(true)
			expect(selectedText(editor)).toBe("a3")
			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(selectedText(editor)).toBe("a1")

			// The last row shown is not the last row: the new row goes below the table's last, and shows.
			select(editor, at("b4"))
			expect(press(view, "Tab")).toBe(true)

			const rows = firstTable(editor)
			const added = rows.child(rows.childCount - 1)

			expect(rows.childCount).toBe(6)
			expect(revisionHidden(added.attrs["revision"] as number, RevisionView.Final)).toBe(false)

			const $head = editor.session.state.selection.$head

			expect($head.node($head.depth - 2)).toBe(added)

			// Original view: the inserted row is not there.
			editor.setView(RevisionView.Original)
			select(editor, at("b2"))
			expect(press(view, "Tab")).toBe(true)
			expect(selectedText(editor)).toBe("a4")
		})

		it("adds a row below the table's last row when vertical merges go on below the last cell shown", async () => {
			const { editor } = await pagedEditor(
				buildDocx({
					body: table([
						[cell("a1"), cell("b1")],
						[cell("a2", '<w:vMerge w:val="restart"/>'), cell("b2", '<w:vMerge w:val="restart"/>')],
						[cell("", "<w:vMerge/>"), cell("", "<w:vMerge/>")]
					])
				})
			)
			const { view } = surface.open(editor)

			select(editor, textPos(editor.body.session.state.doc, "b2", 1))
			expect(press(view, "Tab")).toBe(true)

			const rows = firstTable(editor)
			const $head = editor.session.state.selection.$head

			expect(rows.childCount).toBe(4)
			expect($head.node($head.depth - 2)).toBe(rows.child(3))
			expect($head.node($head.depth - 1).attrs["vMerge"]).toBeNull()
		})

		it("demotes a list paragraph from where its text starts, after zero-width marks (a bookmark)", async () => {
			const bookmarked = '<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Two</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>'
			const { editor } = await pagedEditor(buildDocx({ body: p("One") + bookmarked }))
			const { view } = surface.open(editor)
			const doc = (): Node => editor.body.session.state.doc

			select(editor, 1, doc().content.size - 1)
			await editor.execute({ type: "list.bullet" })
			select(editor, textPos(doc(), "Two"))
			expect(press(view, "Tab")).toBe(true)
			expect(doc().child(1).attrs["ilvl"]).toBe(1)
			expect(tabsIn(doc())).toBe(0)
		})

		it("leaves a Tab whose edit document protection refuses to the browser (focus moves on)", async () => {
			const { editor } = await pagedEditor(
				buildDocx({
					body: p("One") + p("Two"),
					settings: '<w:documentProtection w:edit="forms" w:enforcement="1"/>'
				})
			)
			const { view } = surface.open(editor)
			const doc = editor.body.session.state.doc

			select(editor, textPos(doc, "One", 1))
			expect(press(view, "Tab")).toBe(false)
			expect(press(view, "Tab", { shiftKey: true })).toBe(false)
			select(editor, textPos(doc, "One", 1), textPos(doc, "Two", 1))
			expect(press(view, "Tab")).toBe(false)
			expect(editor.body.session.state.doc).toBe(doc)
		})

		it("inserts a tab character in a cell with Ctrl+Tab (Option+Tab on a Mac)", async () => {
			for (const apple of [false, true]) {
				const { editor } = await pagedEditor(TABLE)
				const { view } = surface.open(editor, { apple })

				select(editor, textPos(editor.body.session.state.doc, "a1", 2))
				expect(press(view, "Tab", apple ? { altKey: true } : { ctrlKey: true })).toBe(true)
				expect(firstTable(editor).child(0).child(0).textContent).toBe("a1")
				expect(tabsIn(firstTable(editor).child(0).child(0))).toBe(1)
				expect(editor.session.state.selection.empty).toBe(true)
			}

			// Off a Mac, Alt+Tab is the system's; Cmd+Tab on one.
			const { editor } = await pagedEditor(TABLE)
			const { view } = surface.open(editor)

			select(editor, textPos(editor.body.session.state.doc, "a1", 2))
			expect(press(view, "Tab", { altKey: true })).toBe(false)
			expect(press(view, "Tab", { metaKey: true })).toBe(false)
			expect(tabsIn(firstTable(editor))).toBe(0)
		})

		it("demotes a list paragraph from its start and promotes it with Shift+Tab, a tab character elsewhere in it", async () => {
			const { editor } = await pagedEditor(buildDocx({ body: p("One") + p("Two") }))
			const { view } = surface.open(editor)
			const doc = (): Node => editor.body.session.state.doc
			const level = (): unknown => doc().child(1).attrs["ilvl"]

			select(editor, 1, doc().content.size - 1)
			await editor.execute({ type: "list.bullet" })

			select(editor, textPos(doc(), "Two"))
			expect(press(view, "Tab")).toBe(true)
			expect(level()).toBe(1)
			expect(tabsIn(doc())).toBe(0)
			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(level()).toBe(0)

			select(editor, textPos(doc(), "Two", 1))
			expect(press(view, "Tab")).toBe(true)
			expect(level()).toBe(0)
			expect(tabsIn(doc().child(1))).toBe(1)
		})

		it("indents several selected paragraphs, and Shift+Tab takes the indent back", async () => {
			const { editor } = await pagedEditor(buildDocx({ body: p("One") + p("Two") + p("Three") }))
			const { view } = surface.open(editor)
			const doc = (): Node => editor.body.session.state.doc
			const indent = (k: number): number => editor.body.session.formats.paragraph(doc().child(k)).props.indent.start

			select(editor, textPos(doc(), "One", 1), textPos(doc(), "Two", 1))
			expect(press(view, "Tab")).toBe(true)
			expect(indent(0)).toBeGreaterThan(0)
			expect(indent(1)).toBe(indent(0))
			expect(indent(2)).toBe(0)
			expect(tabsIn(doc())).toBe(0)
			expect(press(view, "Tab", { shiftKey: true })).toBe(true)
			expect(indent(0)).toBe(0)
			expect(indent(1)).toBe(0)
		})

		it("is described by the element the app names (how Tab works there and how to leave it)", async () => {
			const { editor } = await pagedEditor(TABLE)

			expect(surface.open(editor, { describedBy: "keys" }).view.dom.getAttribute("aria-describedby")).toBe("keys")
			expect(surface.open((await pagedEditor(TABLE)).editor).view.dom.hasAttribute("aria-describedby")).toBe(false)
		})

		it("leaves a Tab alone while composing, and read-only (focus moves on)", async () => {
			const { editor } = await pagedEditor(TABLE)
			const { view } = surface.open(editor)
			const doc = editor.body.session.state.doc

			select(editor, textPos(doc, "a1", 1))
			expect(press(view, "Tab", { isComposing: true })).toBe(false)
			expect(editor.body.session.state.doc).toBe(doc)
			expect(editor.session.state.selection.empty).toBe(true)

			const readOnly = await pagedEditor(TABLE)
			const shown = surface.open(readOnly.editor, { readOnly: true })

			select(readOnly.editor, textPos(readOnly.editor.body.session.state.doc, "a1", 1))
			expect(press(shown.view, "Tab")).toBe(false)
			expect(readOnly.editor.session.state.selection.empty).toBe(true)
		})
	})
}
