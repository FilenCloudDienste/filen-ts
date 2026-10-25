// @vitest-environment jsdom

import { createElement, createRef, type ComponentProps } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { EditorView, runScopeHandlers } from "@codemirror/view"
import "@/lib/i18n"
import type { MarkdownBar } from "@/features/preview/components/codeCommandBar"

// The text and code viewers' command bar over a real editor: a keystroke re-renders only the position and the undo
// and redo buttons (the rest of the bar renders on the dirty edge and settings alone), find and replace live in the
// bar instead of CodeMirror's panel, the view settings are kept on this device, the status tells the file's line
// ending and encoding, and the markdown view switch locks while the source has unsaved edits.

const { renders, stored, frames } = vi.hoisted(() => ({
	renders: new Map<string, number>(),
	stored: new Map<string, unknown>(),
	frames: [] as FrameRequestCallback[]
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve()
}))

// Every command button counts its renders by name: the tests run uncompiled, so a render of the bar renders every
// one of them again.
vi.mock("@/features/office/components/ribbon/ribbonControls", async () => {
	const actual = await vi.importActual<typeof import("@/features/office/components/ribbon/ribbonControls")>(
		"@/features/office/components/ribbon/ribbonControls"
	)

	return {
		...actual,
		RibbonButton: (props: ComponentProps<typeof actual.RibbonButton>) => {
			renders.set(props.label, (renders.get(props.label) ?? 0) + 1)

			return createElement(actual.RibbonButton, props)
		}
	}
})

const { CodeSurface } = await import("@/features/preview/components/codeSurface")
const { readTextFile } = await import("@/features/preview/lib/textFile")
const { PREVIEW_ACTIONS } = await import("@/features/preview/lib/keymap")
const { registerAction } = await import("@/lib/keymap/registry")

beforeAll(() => {
	for (const def of PREVIEW_ACTIONS) {
		registerAction(def)
	}
})

beforeEach(() => {
	renders.clear()
	frames.length = 0
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
	vi.stubGlobal("cancelAnimationFrame", () => undefined)
})

afterEach(() => {
	stored.clear()
})

function flushFrames(): void {
	act(() => {
		for (const frame of frames.splice(0)) frame(0)
	})
}

function mount(
	text: string,
	options?: { editable?: boolean; tag?: string; markdown?: MarkdownBar; contentRef?: { current: (() => string) | null } }
) {
	const bytes = new TextEncoder().encode(text)

	render(
		<CodeSurface
			file={readTextFile(bytes)}
			tag={options?.tag ?? "javascript"}
			alt="file.js"
			editable={options?.editable ?? true}
			locked={false}
			markdown={options?.markdown}
			contentRef={options?.contentRef}
		/>
	)

	const dom = document.querySelector<HTMLElement>(".cm-editor")
	const view = dom === null ? null : EditorView.findFromDOM(dom)

	if (view === null) throw new Error("no editor view")

	return view
}

function type(view: EditorView, text: string): void {
	act(() => {
		view.dispatch({
			changes: { from: view.state.doc.length, insert: text },
			selection: { anchor: view.state.doc.length + text.length },
			userEvent: "input.type"
		})
	})
}

function press(view: EditorView, key: string, modifiers?: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): boolean {
	let handled = false

	act(() => {
		handled = runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...modifiers }), "editor")
	})

	return handled
}

describe("the text and code command bar", () => {
	it("leaves the bar alone on a keystroke: only the position and undo and redo follow", () => {
		const view = mount("const a = 1")

		// The first edit makes the file dirty, which the bar shows (View changes turns on): one render, on the edge.
		type(view, ";")
		flushFrames()

		const find = renders.get("Find") ?? 0
		const wrap = renders.get("Wrap lines") ?? 0
		const undo = renders.get("Undo") ?? 0

		for (const key of ["x", "y", "z", "w"]) {
			type(view, key)
			flushFrames()
		}

		expect(renders.get("Find")).toBe(find)
		expect(renders.get("Wrap lines")).toBe(wrap)
		// Undo turned on with the first edit and stays on: not rendered again either.
		expect(renders.get("Undo")).toBe(undo)
		expect(screen.getByText("Ln 1, Col 17")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false)
		expect(screen.getByRole("button", { name: "View changes" }).hasAttribute("disabled")).toBe(false)
	})

	it("settles the status once a frame, however many transactions came before it", () => {
		const view = mount("abc")

		act(() => {
			view.dispatch({ selection: { anchor: 1 } })
			view.dispatch({ selection: { anchor: 2, head: 3 } })
		})
		expect(screen.getByText("Ln 1, Col 1")).toBeTruthy()
		flushFrames()
		expect(screen.getByText("Ln 1, Col 4 (1 selected)")).toBeTruthy()
	})

	it("finds and replaces in the bar, on the editor's own keys, without CodeMirror's panel", async () => {
		const view = mount("let cat = cat + cat")

		expect(press(view, "f", { ctrlKey: true })).toBe(true)

		const field = await screen.findByRole("searchbox", { name: "Find" })

		expect(document.querySelector(".cm-search")).toBeNull()
		expect(screen.queryByRole("toolbar", { name: "Commands" })).toBeNull()

		fireEvent.change(field, { target: { value: "cat" } })
		fireEvent.keyDown(field, { key: "Enter" })
		expect(await screen.findByText("1/3")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Toggle replace" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), { target: { value: "dog" } })
		fireEvent.click(screen.getByRole("button", { name: "Replace all" }))
		expect(view.state.doc.toString()).toBe("let dog = dog + dog")
		expect(document.querySelector(".cm-search")).toBeNull()

		fireEvent.keyDown(field, { key: "Escape" })
		expect(await screen.findByRole("toolbar", { name: "Commands" })).toBeTruthy()
	})

	it("opens the bar's find for the next-match keys and go to line for its key", async () => {
		const view = mount("a\nb\nc")

		expect(press(view, "g", { ctrlKey: true })).toBe(true)
		expect(await screen.findByRole("searchbox", { name: "Find" })).toBeTruthy()
		expect(document.querySelector(".cm-search")).toBeNull()

		expect(press(view, "g", { ctrlKey: true, altKey: true })).toBe(true)

		const dialog = await screen.findByRole("dialog", { name: "Go to line" })

		fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "3:1" } })
		fireEvent.click(within(dialog).getByRole("button", { name: "Go" }))
		expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
	})

	it("keeps wrap, line numbers and the font size on this device and applies them at once", async () => {
		const view = mount("x")

		expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true)
		fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }))
		expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false)

		expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Line numbers" }))
		expect(view.dom.querySelector(".cm-lineNumbers")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Font size, 13 px" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "18 px" }))
		expect(view.dom.closest<HTMLElement>("[style]")?.style.fontSize).toBe("18px")

		await waitFor(() => {
			expect(stored.get("preview.codeView.v1")).toEqual({ wrap: false, lineNumbers: false, fontSize: 18 })
		})

		// Put back for the other tests (the setting is one value for every viewer).
		fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }))
		fireEvent.click(screen.getByRole("button", { name: "Line numbers" }))
		fireEvent.click(screen.getByRole("button", { name: "Font size, 18 px" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "13 px" }))
	})

	it("switches the language and the indentation from the View group", async () => {
		mount("def f():\n    return 1\n", { tag: "" })

		expect(screen.getByText("Plain text")).toBeTruthy()
		// Commenting and folding need a grammar.
		expect(screen.queryByRole("button", { name: "Fold all" })).toBeNull()
		expect(screen.getByText("Spaces: 4")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Language" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Python" }))
		expect(await screen.findByText("Python")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Fold all" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Indentation" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Tabs" }))
		expect(await screen.findByText("Tabs")).toBeTruthy()
	})

	it("tells a CRLF file with a byte order mark, and saves it as it was", async () => {
		const contentRef = createRef<(() => string) | null>() as { current: (() => string) | null }
		const view = mount("﻿a\r\nb", { contentRef })

		expect(screen.getByText("UTF-8 with BOM")).toBeTruthy()
		expect(screen.getByText("Line endings: CRLF")).toBeTruthy()

		type(view, "\nc")
		await waitFor(() => {
			expect(contentRef.current?.()).toBe("﻿a\r\nb\r\nc")
		})
	})

	it("shows a read-only file as such, without editing commands", () => {
		mount("x", { editable: false })

		expect(screen.getByText("Read-only")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Find and replace" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Toggle comment" })).toBeNull()
		expect(screen.getByRole("button", { name: "Find" })).toBeTruthy()
	})

	it("compares the edits with the file as opened", async () => {
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))

		const view = mount("one")

		type(view, " two")
		fireEvent.click(screen.getByRole("button", { name: "View changes" }))
		expect(await screen.findByRole("dialog", { name: "View changes" })).toBeTruthy()
	})

	it("formats markdown from the bar and locks the view switch while the source has unsaved edits", () => {
		const onMode = vi.fn()
		const view = mount("word", { tag: "markdown", markdown: { mode: "source", locked: true, onMode } })

		act(() => {
			view.dispatch({ selection: { anchor: 0, head: 4 } })
		})
		fireEvent.click(screen.getByRole("button", { name: "Bold" }))
		expect(view.state.doc.toString()).toBe("**word**")

		const rendered = screen.getByRole("button", { name: "Rendered" })

		expect(rendered.getAttribute("aria-disabled")).toBe("true")
		expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(rendered)
		expect(onMode).not.toHaveBeenCalled()
	})
})
