// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Compartment, EditorState, StateEffect, type Extension, type Transaction } from "@codemirror/state"
import { EditorView, runScopeHandlers } from "@codemirror/view"
import { CodeEditor } from "../react/code/index"
import { codeLanguageExtensions, codeLanguageForExtension, isCodeLanguageId, CODE_LANGUAGES } from "../core/code/index"
import {
	CODE_EDITOR_SCOPE,
	codeEditorSetup,
	codeFillParent,
	codeKeymap,
	codeLanguageSupport,
	codeLineNumbers,
	codeReadOnly,
	codeTheme,
	mountCodeCompare
} from "../dom/code/index"
import type { CodeLanguageId } from "../core/code/languages"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
	container = document.createElement("div")
	document.body.append(container)
	root = createRoot(container)
})

afterEach(() => {
	act(() => root.unmount())
	container.remove()
})

function viewIn(element: Element): EditorView {
	const dom = element.querySelector<HTMLElement>(".cm-editor")
	const view = dom === null ? null : EditorView.findFromDOM(dom)

	if (view === null) {
		throw new Error("no editor view")
	}

	return view
}

// Counts the reconfigurations a view goes through.
function reconfigurations(): { extension: Extension; count: () => number } {
	let count = 0

	return {
		extension: EditorState.transactionExtender.of((transaction: Transaction) => {
			if (transaction.effects.some(effect => effect.is(StateEffect.reconfigure)) || transaction.reconfigured) {
				count += 1
			}

			return null
		}),
		count: () => count
	}
}

describe("CodeEditor", () => {
	it("opens on its doc, hands the view over once and labels the content", () => {
		const onCreate = vi.fn<(view: EditorView) => void>()

		act(() =>
			root.render(
				<CodeEditor
					doc={"a\r\nb"}
					extensions={[]}
					label="notes.txt"
					onCreate={onCreate}
				/>
			)
		)

		const view = viewIn(container)

		expect(view.state.doc.toString()).toBe("a\nb")
		expect(onCreate).toHaveBeenCalledTimes(1)
		expect(onCreate).toHaveBeenCalledWith(view)
		expect(view.contentDOM.getAttribute("aria-label")).toBe("notes.txt")
	})

	it("never reseeds from a later doc and keeps the buffer across a reconfiguration", () => {
		const first: Extension = []

		act(() =>
			root.render(
				<CodeEditor
					doc="saved"
					extensions={first}
				/>
			)
		)

		const view = viewIn(container)

		act(() => view.dispatch({ changes: { from: 5, insert: "!" } }))
		act(() =>
			root.render(
				<CodeEditor
					doc="elsewhere"
					extensions={codeReadOnly(true)}
				/>
			)
		)

		expect(viewIn(container)).toBe(view)
		expect(view.state.doc.toString()).toBe("saved!")
		expect(view.state.readOnly).toBe(true)
	})

	it("reconfigures only when the extensions or the label change", () => {
		const counter = reconfigurations()
		const extensions: Extension = [counter.extension]
		const render = (label: string) =>
			act(() =>
				root.render(
					<CodeEditor
						doc=""
						extensions={extensions}
						label={label}
					/>
				)
			)

		render("a")
		render("a")
		render("a")

		expect(counter.count()).toBe(0)

		render("b")

		expect(counter.count()).toBe(1)
		expect(viewIn(container).contentDOM.getAttribute("aria-label")).toBe("b")
	})

	it("destroys its view on unmount", () => {
		act(() =>
			root.render(
				<CodeEditor
					doc="x"
					extensions={[]}
				/>
			)
		)

		const view = viewIn(container)
		const destroy = vi.spyOn(view, "destroy")

		act(() => root.render(<div />))

		expect(destroy).toHaveBeenCalledTimes(1)
		expect(container.querySelector(".cm-editor")).toBeNull()
	})
})

describe("code editor extensions", () => {
	it("builds every language's grammar once and hands the same instance back", () => {
		for (const id of Object.keys(CODE_LANGUAGES)) {
			if (!isCodeLanguageId(id)) {
				throw new Error(id)
			}

			const extension = codeLanguageSupport(id)

			expect(extension).toBe(codeLanguageSupport(id))
			expect(() => EditorState.create({ doc: "x = 1", extensions: extension })).not.toThrow()
		}
	})

	it("has a grammar for every extension in the table", () => {
		const ids = new Set<CodeLanguageId>()

		for (const extension of codeLanguageExtensions()) {
			const id = codeLanguageForExtension(extension)

			if (id !== null) {
				ids.add(id)
			}
		}

		expect(ids.size).toBe(Object.keys(CODE_LANGUAGES).length)
	})

	it("composes the full setup with theme, language and keymaps into a working editor", () => {
		const view = new EditorView({
			doc: "const a = 1",
			extensions: [codeFillParent, codeEditorSetup(), codeTheme, codeLanguageSupport("typescript")],
			parent: container
		})

		expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull()
		expect(view.state.facet(EditorState.allowMultipleSelections)).toBe(true)
		view.destroy()
	})

	it("leaves the line numbers to an app that switches them itself", () => {
		const lines = new Compartment()
		const view = new EditorView({
			doc: "a\nb",
			extensions: [codeEditorSetup({ lineNumbers: false }), lines.of([])],
			parent: container
		})

		expect(view.dom.querySelector(".cm-lineNumbers")).toBeNull()
		view.dispatch({ effects: lines.reconfigure(codeLineNumbers) })
		expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull()
		view.destroy()
	})

	it("is read-only and not editable when locked", () => {
		const state = EditorState.create({ extensions: codeReadOnly(true) })

		expect(state.readOnly).toBe(true)
		expect(state.facet(EditorView.editable)).toBe(false)
		expect(EditorState.create({ extensions: codeReadOnly(false) }).readOnly).toBe(false)
	})

	it("runs the app's bindings in their scope and leaves Mod-f to the app", () => {
		const run = vi.fn(() => true)
		const view = new EditorView({
			doc: "x",
			extensions: [codeKeymap([{ keys: ["Ctrl-b"], run, scope: CODE_EDITOR_SCOPE }])],
			parent: container
		})
		const press = (key: string, modifier: "ctrlKey" | "metaKey") =>
			runScopeHandlers(view, new KeyboardEvent("keydown", { key, [modifier]: true }), CODE_EDITOR_SCOPE)

		expect(press("b", "ctrlKey")).toBe(true)
		expect(run).toHaveBeenCalledTimes(1)
		expect(press("f", "ctrlKey")).toBe(false)
		expect(press("f", "metaKey")).toBe(false)
		view.destroy()
	})

	it("mounts a side-by-side or a unified comparison and removes it again", () => {
		for (const sideBySide of [true, false]) {
			const destroy = mountCodeCompare({
				parent: container,
				theirs: "one\ntwo",
				mine: "one\nthree",
				sideBySide,
				extensions: codeTheme
			})

			expect(container.textContent).toContain("three")
			expect(container.querySelector(sideBySide ? ".cm-mergeView" : ".cm-changedLine, .cm-deletedChunk")).not.toBeNull()

			destroy()

			expect(container.querySelector(".cm-editor")).toBeNull()
		}
	})
})
