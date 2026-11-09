// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Selection } from "prosemirror-state"
import { findInStory, selectMatch } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// Word's Navigation pane and word count on a real document: Find (Ctrl+F) opens the pane's search, its results list
// the matches and go to one, the Headings tab lists and goes to headings, the View tab shows and hides the pane, and
// the status bar counts words (of the selection too) and opens the Word Count dialog.

const hooks = vi.hoisted(() => ({ hosts: [] as DocxEditingHost[] }))

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

vi.mock("@/features/preview/lib/docxEngine", () => ({ DOCX_FONT_URLS: {} }))
vi.mock("@/features/preview/lib/docxEditing", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/lib/docxEditing")>("@/features/preview/lib/docxEditing")
	const { inThreadEditingHost } = await vi.importActual<typeof import("@filen/office/dom/docx/editing")>("@filen/office/dom/docx/editing")
	const { prepareDocxSave, writerProof } =
		await vi.importActual<typeof import("@filen/office/core/docx/write")>("@filen/office/core/docx/write")

	return {
		...actual,
		docxEditingHost: () => {
			const host = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
					sliceMs: 8
				}),
				{ proof: writerProof, writer: { prepare: prepareDocxSave } }
			)

			hooks.hosts.push(host)

			return host
		}
	}
})
vi.mock("@/features/spellcheck/lib/spellcheck", () => ({
	defaultSpellingLanguage: () => "en-US",
	documentSpellingChecker: {
		dictionaryFor: () => undefined,
		known: () => true,
		check: () => Promise.resolve(),
		suggest: () => Promise.resolve([]),
		addToDictionary: () => Promise.resolve(),
		subscribe: () => () => undefined
	}
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	saveOfficeAutosave: () => Promise.resolve(),
	useOfficeSettings: () => ({ authorName: null, autosave: false, loaded: true })
}))
vi.mock("sonner", () => ({
	toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/trustedLinks/trustedDomainsQuery", () => ({ useTrustedDomainsQuery: () => ({ data: new Set<string>() }) }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { DocxEditView } = await import("@/features/preview/components/docxEditor")

registerAllActions()

const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))

async function openEditor(): Promise<PagedEditor> {
	// happy-dom lays nothing out (every size is 0): the pane's lists get a height, so their rows in view are drawn.
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
		return this.closest("aside") === null ? 0 : 800
	})
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
		return this.closest("aside") === null ? 0 : 288
	})

	render(
		<DocxEditView
			bytes={BYTES}
			alt="report.docx"
			writable
			renamed={false}
			onDirtyChange={() => undefined}
			saveRef={{ current: null }}
			onAutosave={() => true}
			viewer={() => <div>viewer</div>}
		/>
	)

	const host = hooks.hosts.at(-1)

	if (host === undefined) {
		throw new Error("no editing host")
	}

	const editor: PagedEditor = await act(() => host.editor)

	await waitFor(() => {
		expect(screen.getByRole("textbox", { name: "report.docx" })).toBeTruthy()
	})

	return editor
}

function firstTextblock(editor: PagedEditor): number {
	let pos = -1

	editor.state.doc.descendants((node, at) => {
		if (pos < 0 && node.isTextblock && node.textContent.length > 0) {
			pos = at
		}

		return pos < 0
	})

	return pos
}

function typeAtStart(editor: PagedEditor, text: string): void {
	act(() => {
		editor.dispatch(editor.state.tr.insertText(text, firstTextblock(editor) + 1))
	})
}

function pane(): HTMLElement {
	return screen.getByRole("complementary", { name: "Navigation" })
}

afterEach(() => {
	cleanup()
	hooks.hosts.length = 0
})

describe("Navigation pane", () => {
	it("opens with Find focused on its search box, lists each match in context and goes to the one picked", async () => {
		const editor = await openEditor()

		typeAtStart(editor, "zebra one zebra two ")
		fireEvent.click(screen.getByRole("button", { name: "Find in document" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Find in document" }))

		const search = await within(pane()).findByRole("searchbox", { name: "Search document" })

		await waitFor(() => {
			expect(document.activeElement).toBe(search)
		})
		// Find opens no find bar in the ribbon.
		expect(screen.queryByRole("searchbox", { name: "Find" })).toBeNull()
		fireEvent.change(search, { target: { value: "zebra" } })
		expect(within(pane()).getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true")
		await waitFor(() => {
			expect(within(pane()).getByRole("status").textContent).toBe("Result 1 of 2")
		})

		const results = within(pane()).getAllByRole("button", { name: /zebra/u })
		const second = results[1]

		if (second === undefined) {
			throw new Error("no second result")
		}

		expect(results).toHaveLength(2)
		expect(second.textContent).toContain("one zebra two")
		fireEvent.click(second)
		await waitFor(() => {
			expect(within(pane()).getByRole("status").textContent).toBe("Result 2 of 2")
		})

		const { from, to } = editor.state.selection

		expect(editor.state.doc.textBetween(from, to)).toBe("zebra")
		expect(from).toBeGreaterThan(firstTextblock(editor) + 5)

		// Enter in the box steps to the next match, wrapping round.
		fireEvent.keyDown(search, { key: "Enter" })
		await waitFor(() => {
			expect(within(pane()).getByRole("status").textContent).toBe("Result 1 of 2")
		})
	})

	it("opens from Ctrl+F in the document, gives Escape back to the document and closes from its button", async () => {
		await openEditor()

		const area = screen.getByRole("textbox", { name: "report.docx" })

		fireEvent.keyDown(area, { key: "f", code: "KeyF", ctrlKey: true, metaKey: true })
		expect(await within(pane()).findByRole("searchbox", { name: "Search document" })).toBeTruthy()

		const tab = within(pane()).getByRole("tab", { name: "Pages" })

		act(() => {
			tab.focus()
		})
		// Taken: the preview closes only on an Escape nothing took.
		expect(fireEvent.keyDown(tab, { key: "Escape" })).toBe(false)
		await waitFor(() => {
			expect(area.contains(document.activeElement)).toBe(true)
		})
		fireEvent.click(within(pane()).getByRole("button", { name: "Close navigation pane" }))
		await waitFor(() => {
			expect(screen.queryByRole("complementary", { name: "Navigation" })).toBeNull()
		})
	})

	it("is shown and hidden from the View tab, and lists the headings, going to the one clicked", async () => {
		const editor = await openEditor()
		const start = firstTextblock(editor)

		await act(async () => {
			editor.select({ pos: start + 1, affinity: 1, page: 0, line: 0, atom: false })
			await editor.execute({ type: "style.set", style: "heading1" })
		})
		expect(editor.state.doc.nodeAt(start)?.attrs["styleId"]).toMatch(/^Heading1/u)

		const heading = editor.state.doc.nodeAt(start)?.textContent ?? ""

		fireEvent.click(screen.getByRole("tab", { name: "View" }))

		const toggle = await screen.findByRole("button", { name: "Navigation pane" })

		expect(toggle.getAttribute("aria-pressed")).toBe("false")
		fireEvent.click(toggle)
		expect(screen.getByRole("button", { name: "Navigation pane" }).getAttribute("aria-pressed")).toBe("true")

		const list = await within(pane()).findByRole("list", { name: "Headings" })
		const entry = await within(list).findByRole("button", { name: heading })

		// The caret elsewhere first: the heading goes back there.
		act(() => {
			editor.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)))
		})
		fireEvent.click(entry)
		expect(editor.state.selection.$from.parent.textContent).toBe(heading)

		fireEvent.click(screen.getByRole("button", { name: "Navigation pane" }))
		await waitFor(() => {
			expect(screen.queryByRole("complementary", { name: "Navigation" })).toBeNull()
		})
	})

	it("moves a heading dragged above another, with its content", async () => {
		const editor = await openEditor()
		const blocks: number[] = []

		editor.state.doc.forEach((node, at) => {
			if (node.isTextblock && node.textContent.length > 0 && blocks.length < 2) {
				blocks.push(at)
			}
		})

		for (const at of blocks) {
			await act(async () => {
				editor.select({ pos: at + 1, affinity: 1, page: 0, line: 0, atom: false })
				await editor.execute({ type: "style.set", style: "heading1" })
			})
		}

		const [first, second] = blocks.map(at => editor.state.doc.nodeAt(at)?.textContent ?? "")

		if (first === undefined || second === undefined) {
			throw new Error("Expected two non-empty text blocks")
		}

		fireEvent.click(screen.getByRole("tab", { name: "View" }))
		fireEvent.click(await screen.findByRole("button", { name: "Navigation pane" }))

		const list = await within(pane()).findByRole("list", { name: "Headings" })
		const dragged = await within(list).findByRole("button", { name: second })
		const target = within(list).getByRole("button", { name: first })
		const dataTransfer = { effectAllowed: "", setData: vi.fn() }

		expect(dragged.getAttribute("draggable")).toBe("true")
		fireEvent.dragStart(dragged, { dataTransfer })
		// The upper half of the first heading's row: before it.
		fireEvent.dragOver(target, { dataTransfer, clientY: -1 })
		fireEvent.drop(target, { dataTransfer, clientY: -1 })

		const texts: string[] = []

		editor.state.doc.forEach(node => {
			if (node.textContent === first || node.textContent === second) {
				texts.push(node.textContent)
			}
		})
		expect(texts).toEqual([second, first])
		expect(editor.state.selection.$from.parent.textContent).toBe(second)
	})

	it("shows page thumbnails that go to their page", async () => {
		await openEditor()
		fireEvent.click(screen.getByRole("tab", { name: "View" }))
		fireEvent.click(await screen.findByRole("button", { name: "Navigation pane" }))
		fireEvent.click(within(pane()).getByRole("tab", { name: "Pages" }))

		const first = await within(pane()).findByRole("button", { name: "Page 1" })

		expect(first.getAttribute("aria-current")).toBe("page")
		expect(first.querySelector("canvas")).not.toBeNull()
	})
})

describe("word count", () => {
	it("counts the document's words in the status bar, the selection's beside them, and opens Word Count", async () => {
		const editor = await openEditor()
		const total = await waitFor(() => {
			const status = screen.getByRole("button", { name: /, word count$/u })
			const words = /^([\d,]+) words?$/u.exec(status.textContent)

			expect(words).not.toBeNull()

			return Number((words?.[1] ?? "").replaceAll(",", ""))
		})

		expect(total).toBeGreaterThan(0)

		typeAtStart(editor, "okapi ")
		await waitFor(() => {
			expect(screen.getByRole("button", { name: /, word count$/u }).textContent).toBe(`${(total + 1).toLocaleString("en")} words`)
		})

		act(() => {
			const match = findInStory(editor.state.doc, "okapi")[0]
			const tr = match === undefined ? null : selectMatch(editor.state, match)

			if (tr !== null) {
				editor.dispatch(tr)
			}
		})
		await waitFor(() => {
			expect(screen.getByRole("button", { name: /, word count$/u }).textContent).toBe(
				`1 of ${(total + 1).toLocaleString("en")} words`
			)
		})

		act(() => {
			editor.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)))
		})
		fireEvent.click(await screen.findByRole("button", { name: /words, word count$/u }))

		const dialog = await screen.findByRole("dialog", { name: "Word count" })
		const value = (label: string): string | null | undefined => within(dialog).getByText(label).nextElementSibling?.textContent

		await waitFor(() => {
			expect(value("Words")).toBe((total + 1).toLocaleString("en"))
		})
		expect(Number(value("Pages"))).toBe(editor.pageCount)
		expect(Number(value("Lines"))).toBeGreaterThan(0)
		expect(within(dialog).getByRole("checkbox", { name: "Include text boxes, footnotes and endnotes" })).toHaveProperty("checked", true)
	})
})
