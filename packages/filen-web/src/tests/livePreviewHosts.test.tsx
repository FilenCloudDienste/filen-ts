// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { undo, undoDepth } from "@codemirror/commands"
import { EditorState } from "@codemirror/state"
import { ensureSyntaxTree } from "@codemirror/language"
import { codeLanguageSupport } from "@filen/office/dom/code"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { editorView } from "@/tests/support/codeMirror"

// The live preview in its hosts: the file preview's markdown (MarkdownViewer) and the editor both share
// (CodeMirrorSource). The editing views switch in one editor, the choice is the device's, a file that cannot be edited
// opens in Read, a task box edits the source, and a document past live preview's size edits as Source.

const { source, fits } = vi.hoisted(() => ({ source: { text: "# Title\n\n- [ ] task\n" }, fits: { value: true } }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new TextEncoder().encode(source.text), refetch: vi.fn() })
}))
vi.mock("@/features/preview/lib/markdownView", async original => {
	const actual = await original<typeof import("@/features/preview/lib/markdownView")>()

	return { ...actual, livePreviewFits: (text: string) => fits.value && actual.livePreviewFits(text) }
})

const { MarkdownViewer } = await import("@/features/preview/components/markdownViewer")
const { CodeMirrorSource } = await import("@/features/preview/components/codeMirrorSource")
const { getMarkdownView, setMarkdownView } = await import("@/features/preview/lib/markdownView")
const { livePreview, livePreviewField } = await import("@/features/preview/lib/livePreview/livePreview")

registerAllActions()

const ITEM = narrowItem({
	uuid: "mdfile-0000-0000-0000-000000000000",
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "notes.md", mime: "text/markdown", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies File)

const CONFIG = {
	image: () => null,
	openLink: () => undefined,
	labels: { imageNotLoaded: (alt: string) => alt, task: "Toggle task", openLink: "" },
	math: null,
	mermaid: null
}

beforeEach(() => {
	source.text = "# Title\n\n- [ ] task\n"
	fits.value = true
	setMarkdownView({ edit: "live", read: false })
})

afterEach(() => {
	cleanup()
})

function renderViewer(editable?: boolean) {
	return render(
		<MarkdownViewer
			item={ITEM}
			alt="notes.md"
			{...(editable === undefined ? {} : { editable })}
		/>,
		{ wrapper: queryClientWrapper(createTestQueryClient()) }
	)
}

function liveOn(container: HTMLElement): boolean {
	return container.querySelector(".cm-editor.cm-lp") !== null
}

describe("the file preview's markdown", () => {
	it("opens an editable file in live preview, its syntax hidden", () => {
		const { container } = renderViewer(true)

		expect(liveOn(container)).toBe(true)
		expect(container.querySelector(".cm-lp-h1")?.textContent).toBe("Title")
		expect(container.querySelector("input.cm-lp-task")).not.toBeNull()
		expect(screen.getByRole("button", { name: "Editing view: Live preview" })).toBeTruthy()
	})

	it("switches to source in the same editor with its key, and remembers it", () => {
		const { container } = renderViewer(true)
		const view = editorView(container)

		fireEvent.keyDown(view.contentDOM, { key: "v", code: "KeyV", ctrlKey: true, altKey: true })

		expect(liveOn(container)).toBe(false)
		expect(editorView(container)).toBe(view)
		expect(view.state.doc.toString()).toBe(source.text)
		expect(getMarkdownView()).toEqual({ edit: "source", read: false })

		fireEvent.keyDown(view.contentDOM, { key: "v", code: "KeyV", ctrlKey: true, altKey: true })

		expect(liveOn(container)).toBe(true)
		expect(editorView(container)).toBe(view)
	})

	it("reads with the Read toggle and returns to the editing view", async () => {
		const { container } = renderViewer(true)

		fireEvent.click(screen.getByRole("button", { name: "Read" }))

		expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy()
		expect(getMarkdownView()).toEqual({ edit: "live", read: true })

		fireEvent.click(screen.getByRole("button", { name: "Read" }))

		expect(liveOn(container)).toBe(true)
	})

	it("opens a file that cannot be edited in Read, whatever was chosen", async () => {
		renderViewer()

		expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Read" }).getAttribute("aria-pressed")).toBe("true")
	})

	it("toggles a task in the source as one undo step", () => {
		const { container } = renderViewer(true)
		const view = editorView(container)
		const box = container.querySelector("input.cm-lp-task")

		if (box === null) {
			throw new Error("no task box")
		}

		fireEvent.mouseDown(box)

		expect(view.state.doc.toString()).toBe("# Title\n\n- [x] task\n")
		expect(undoDepth(view.state)).toBe(1)
		expect(container.querySelector<HTMLInputElement>("input.cm-lp-task")?.checked).toBe(true)

		undo(view)

		expect(view.state.doc.toString()).toBe(source.text)
	})

	it("edits a document past live preview's size as source", () => {
		fits.value = false

		const { container } = renderViewer(true)

		expect(liveOn(container)).toBe(false)
		expect(screen.getByRole("button", { name: "Editing view: Source" })).toBeTruthy()
	})
})

describe("the live preview field", () => {
	it("decorates a stretch around the cursor, never the whole document", () => {
		const doc = Array.from({ length: 5000 }, (_, index) => `**line ${String(index)}**`).join("\n")
		const state = EditorState.create({ doc, extensions: [codeLanguageSupport("markdown"), livePreview(CONFIG)] })

		ensureSyntaxTree(state, state.doc.length, 5000)

		const parsed = state.update({}).state
		const value = parsed.field(livePreviewField)
		let last = 0

		value.decorations.between(0, parsed.doc.length, from => {
			last = Math.max(last, from)
		})

		expect(value.from).toBe(0)
		expect(value.to).toBeLessThan(parsed.doc.length / 10)
		// A node overlapping the stretch is decorated whole.
		expect(last).toBeLessThanOrEqual(parsed.doc.lineAt(value.to).to)
		expect(last).toBeGreaterThan(0)
	})
})

describe("CodeMirrorSource's live preview", () => {
	it("switches on and off in place, keeping the buffer and its history", () => {
		const extension = livePreview(CONFIG)
		const { container, rerender } = render(
			<CodeMirrorSource
				text="**bold**"
				tag="markdown"
				alt="note"
				editable
				livePreview={extension}
			/>
		)
		const view = editorView(container)

		expect(liveOn(container)).toBe(true)

		act(() => {
			view.dispatch({ changes: { from: 8, insert: "!" }, userEvent: "input.type" })
		})

		rerender(
			<CodeMirrorSource
				text="**bold**"
				tag="markdown"
				alt="note"
				editable
				livePreview={null}
			/>
		)

		expect(liveOn(container)).toBe(false)
		expect(editorView(container)).toBe(view)
		expect(view.state.doc.toString()).toBe("**bold**!")
		expect(undoDepth(view.state)).toBe(1)
	})

	it("shows the syntax the cursor touches once the editor has focus", async () => {
		const { container } = render(
			<CodeMirrorSource
				text="# Title"
				tag="markdown"
				alt="note"
				editable
				livePreview={livePreview(CONFIG)}
			/>
		)
		const view = editorView(container)

		expect(view.contentDOM.textContent).toBe("Title")

		// jsdom's document never has focus itself.
		vi.spyOn(document, "hasFocus").mockReturnValue(true)
		act(() => {
			view.focus()
			view.dispatch({ selection: { anchor: 3 } })
		})

		await waitFor(() => {
			expect(view.contentDOM.textContent).toBe("# Title")
		})
	})
})
