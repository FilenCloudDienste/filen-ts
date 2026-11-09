// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { TextSelection } from "prosemirror-state"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// The Word editor shows its Mini toolbar for a selection made with the mouse and with a context menu opened by a right
// click, never for a selection made with the keyboard nor a menu opened from it; a key typed hides it.

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

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures", name)))
const BYTES = fixture("01-plain.docx")

async function openEditor(bytes: Uint8Array = BYTES): Promise<PagedEditor> {
	render(
		<DocxEditView
			bytes={bytes}
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

// Selects the first paragraph's first characters, as a drag or the keyboard would.
function selectStart(editor: PagedEditor): void {
	let pos = -1

	editor.state.doc.descendants((node, at) => {
		if (pos < 0 && node.isTextblock && node.textContent.length > 3) {
			pos = at + 1
		}

		return pos < 0
	})
	act(() => {
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos, pos + 3)))
	})
}

// Hidden from assistive technology too while the modal context menu is open.
function miniToolbar(): HTMLElement | null {
	return screen.queryByRole("toolbar", { name: "Mini toolbar", hidden: true })
}

// The frame the toolbar is read in.
async function nextFrame(): Promise<void> {
	await act(
		() =>
			new Promise<void>(resolve =>
				requestAnimationFrame(() => {
					resolve()
				})
			)
	)
}

afterEach(() => {
	cleanup()
	hooks.hosts.length = 0
})

describe("The Word editor's Mini toolbar", () => {
	it("appears faded above a selection made with the mouse and goes on a key typed", async () => {
		const editor = await openEditor()
		const page = screen.getByRole("textbox", { name: "report.docx" })

		expect(miniToolbar()).toBeNull()
		fireEvent.pointerDown(page, { pointerType: "mouse", button: 0, isPrimary: true, clientX: 200, clientY: 200 })
		selectStart(editor)
		fireEvent.pointerUp(page, { pointerType: "mouse", button: 0, isPrimary: true, clientX: 240, clientY: 200 })
		await nextFrame()

		const toolbar = miniToolbar()

		if (toolbar === null) {
			throw new Error("no Mini toolbar")
		}

		expect(toolbar.getAttribute("data-docx-mini-toolbar")).toBe("selection")
		expect(Number(toolbar.style.opacity)).toBeLessThan(1)
		fireEvent.click(within(toolbar).getByRole("button", { name: "Bold" }))
		await waitFor(() => {
			expect(screen.getAllByRole("button", { name: "Bold" }).every(button => button.getAttribute("aria-pressed") === "true")).toBe(
				true
			)
		})
		fireEvent.keyDown(page, { key: "x" })
		await waitFor(() => {
			expect(miniToolbar()).toBeNull()
		})
	})

	it("does not appear for a selection made with the keyboard, nor for a click that selects nothing", async () => {
		const editor = await openEditor()
		const page = screen.getByRole("textbox", { name: "report.docx" })

		selectStart(editor)
		fireEvent.keyUp(page, { key: "ArrowRight", shiftKey: true })
		await nextFrame()
		expect(miniToolbar()).toBeNull()

		act(() => {
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, editor.state.selection.from)))
		})
		fireEvent.pointerDown(page, { pointerType: "mouse", button: 0, isPrimary: true })
		fireEvent.pointerUp(page, { pointerType: "mouse", button: 0, isPrimary: true })
		await nextFrame()
		expect(miniToolbar()).toBeNull()
	})

	it("does not appear for the double click that opens a header", async () => {
		const editor = await openEditor(fixture("03-header-footer-footnotes.docx"))
		const page = screen.getByRole("textbox", { name: "report.docx" })
		const header = editor.session.context.model.stories.findIndex(story => story.kind === "header")

		expect(header).toBeGreaterThanOrEqual(0)
		fireEvent.pointerDown(page, { pointerType: "mouse", button: 0, isPrimary: true, clientX: 200, clientY: 100 })
		// The press opens the header and selects a word of it, as the double click does.
		act(() => {
			expect(editor.enterStory(header, 0)).toBe(true)
		})
		selectStart(editor)
		expect(editor.selection().empty).toBe(false)
		fireEvent.pointerUp(page, { pointerType: "mouse", button: 0, isPrimary: true, clientX: 200, clientY: 100 })
		await nextFrame()
		expect(miniToolbar()).toBeNull()

		// A selection made in the header once it is open shows it.
		fireEvent.pointerDown(page, { pointerType: "mouse", button: 0, isPrimary: true, clientX: 200, clientY: 100 })
		selectStart(editor)
		fireEvent.pointerUp(page, { pointerType: "mouse", button: 0, isPrimary: true, clientX: 240, clientY: 100 })
		await nextFrame()
		expect(miniToolbar()).not.toBeNull()
	})

	it("does not appear for a touch selection", async () => {
		const editor = await openEditor()
		const page = screen.getByRole("textbox", { name: "report.docx" })

		fireEvent.pointerDown(page, { pointerType: "touch", button: 0, isPrimary: true })
		selectStart(editor)
		fireEvent.pointerUp(page, { pointerType: "touch", button: 0, isPrimary: true })
		await nextFrame()
		expect(miniToolbar()).toBeNull()
	})

	it("appears opaque with the context menu a right click opens, not with one the keyboard opens", async () => {
		await openEditor()
		const page = screen.getByRole("textbox", { name: "report.docx" })

		fireEvent.contextMenu(page, { button: 0, clientX: 300, clientY: 300 })
		await screen.findByRole("menuitem", { name: "Select all" })
		expect(miniToolbar()).toBeNull()
		fireEvent.keyDown(document.activeElement ?? page, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("menuitem", { name: "Select all" })).toBeNull()
		})

		fireEvent.contextMenu(page, { button: 2, clientX: 300, clientY: 300 })
		await screen.findByRole("menuitem", { name: "Select all" })

		const toolbar = miniToolbar()

		expect(toolbar?.getAttribute("data-docx-mini-toolbar")).toBe("menu")
		expect(toolbar?.style.opacity).toBe("1")
		// The menu closing for anything but a press on the toolbar takes it along.
		fireEvent.click(screen.getByRole("menuitem", { name: "Select all" }))
		await waitFor(() => {
			expect(miniToolbar()).toBeNull()
		})
	})
})
