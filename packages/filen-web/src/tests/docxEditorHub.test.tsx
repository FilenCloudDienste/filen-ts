// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import type { DocxEditorInteractions } from "@filen/office/react/docx/editor"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// The hub's routing on a real document: presses in Mobile view (a comment's highlight to the comment popover, a
// picture to the picture's press), the balloon column's room at fit zoom, and the review layer keeping its own
// context menu, paste and drop. Mobile view, the popover and the picture press stand in for their slices'.

const hooks = vi.hoisted(() => ({
	hosts: [] as DocxEditingHost[],
	reflow: false,
	width: 900,
	pressed: [] as { kind: string; surface: string; page: number }[],
	interactions: undefined as DocxEditorInteractions | undefined,
	paste: vi.fn(),
	drop: vi.fn(),
	// The pages' layout never finishes (Mobile view suspends it).
	layoutPending: false
}))

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
		known: () => undefined,
		check: () => Promise.resolve(),
		suggest: () => Promise.resolve([]),
		addToDictionary: () => Promise.resolve(),
		subscribe: () => () => undefined
	}
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	saveOfficeAutosave: () => Promise.resolve(),
	useOfficeSettings: () => ({ authorName: "Ann", autosave: false, loaded: true })
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: hooks.width, height: 800 }) }))
vi.mock("@/features/preview/components/docxReflow.logic", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/preview/components/docxReflow.logic")>()),
	useReflowMode: () => ({ reflow: hooks.reflow, setReflow: () => undefined })
}))
vi.mock("@/features/preview/components/docxReflowSurface", () => ({
	DocxReflowSurface: (props: { interactions?: DocxEditorInteractions; describedBy?: string }) => {
		hooks.interactions = props.interactions

		return (
			<div
				role="textbox"
				aria-label="reflowed"
				aria-describedby={props.describedBy}
			/>
		)
	}
}))
vi.mock("@/features/preview/components/docxCommentPopover", () => ({
	DocxCommentPopover: (props: { press: { page: number } | null; surface: string }) => {
		if (props.press !== null) {
			hooks.pressed.push({ kind: "commentMarker", surface: props.surface, page: props.press.page })
		}

		return null
	}
}))
vi.mock("@/features/preview/components/docxObjectHandles", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/components/docxObjectHandles")>(
		"@/features/preview/components/docxObjectHandles"
	)),
	DocxDrawingPress: (props: { press: { page: number } | null; surface: string }) => {
		if (props.press !== null) {
			hooks.pressed.push({ kind: "drawing", surface: props.surface, page: props.press.page })
		}

		return null
	}
}))
vi.mock("@filen/office/react/docx", async () => {
	const actual = await vi.importActual<typeof import("@filen/office/react/docx")>("@filen/office/react/docx")

	return {
		...actual,
		useDocxDocument: (...args: Parameters<typeof actual.useDocxDocument>) => {
			const document = actual.useDocxDocument(...args)

			return hooks.layoutPending && document.status !== "error" ? { ...document, status: "loading" as const } : document
		}
	}
})
vi.mock("@/features/preview/components/docxImageInsert", () => ({
	useDocxImageInsert: () => ({
		handlers: { onPasteCapture: hooks.paste, onDragOverCapture: vi.fn(), onDropCapture: hooks.drop },
		paste: () => false,
		dialogs: null
	})
}))

const { DocxEditView } = await import("@/features/preview/components/docxEditor")

registerAllActions()

const FIXTURES = join(process.cwd(), "../filen-office/src/tests/fixtures")

async function openEditor(file: string, writable = true): Promise<PagedEditor> {
	render(
		<DocxEditView
			bytes={new Uint8Array(readFileSync(join(FIXTURES, file)))}
			alt="report.docx"
			writable={writable}
			renamed={false}
			onDirtyChange={() => undefined}
			saveRef={{ current: null }}
			onAutosave={() => true}
			viewer={() => null}
		/>
	)

	const host = hooks.hosts.at(-1)

	if (host === undefined) {
		throw new Error("no editing host")
	}

	const editor = await act(() => host.editor)

	await waitFor(() => {
		expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0)
	})

	return editor
}

function objectPress(kind: "commentMarker" | "drawing") {
	return {
		hit: { kind, story: 0, pos: 1 },
		page: -1,
		x: 0,
		y: 0,
		clientX: 10,
		clientY: 10,
		pointerType: "touch",
		pointerId: 1,
		clicks: 1,
		shiftKey: false
	}
}

afterEach(() => {
	cleanup()
	hooks.hosts.length = 0
	hooks.reflow = false
	hooks.width = 900
	hooks.pressed.length = 0
	hooks.interactions = undefined
	hooks.layoutPending = false
	vi.clearAllMocks()
})

describe("DocxEditView routing", () => {
	it("hands a comment tap in Mobile view to the comment popover, and a picture tap to the picture's press", async () => {
		hooks.reflow = true
		await openEditor("04-comments-tracked.docx")

		const interactions = hooks.interactions

		expect(interactions?.commentMarker).toBeDefined()
		act(() => {
			expect(interactions?.commentMarker?.(objectPress("commentMarker"))).toBe(true)
		})
		await waitFor(() => {
			expect(hooks.pressed).toContainEqual({ kind: "commentMarker", surface: "reflow", page: -1 })
		})
		act(() => {
			interactions?.drawing?.(objectPress("drawing"))
		})
		await waitFor(() => {
			expect(hooks.pressed).toContainEqual({ kind: "drawing", surface: "reflow", page: -1 })
		})
	})

	it("covers Mobile view with no loading spinner once the editor is open, the pages' layout resting", async () => {
		hooks.reflow = true
		hooks.layoutPending = true
		await openEditor("01-plain.docx")
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))
		expect(screen.queryByRole("status", { name: /loading/i })).toBeNull()
		cleanup()

		// The pages still lay out: their spinner shows meanwhile.
		hooks.reflow = false
		await openEditor("01-plain.docx")
		expect(screen.getAllByRole("status").length).toBeGreaterThan(0)
	})

	it("leaves room for the balloon column at fit zoom where comments show and the window has it", async () => {
		await openEditor("04-comments-tracked.docx")
		// 900 px less the 280 px column, less the gutters, over the A4 page's 794 px.
		await waitFor(() => {
			expect(screen.getByRole("button", { name: /^Zoom 74%/ })).toBeTruthy()
		})
		cleanup()

		// Without comments the pages take the width.
		await openEditor("01-plain.docx")
		await waitFor(() => {
			expect(screen.getByRole("button", { name: /^Zoom 100%/ })).toBeTruthy()
		})
	})

	it("describes the editing area's keys (Tab stays in it, Escape leaves) while it can be edited", async () => {
		for (const reflow of [false, true]) {
			hooks.reflow = reflow
			await openEditor("01-plain.docx")
			expect(screen.getAllByRole("textbox")[0]?.getAttribute("aria-describedby")).toBeTruthy()
			expect(document.getElementById(screen.getAllByRole("textbox")[0]?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
				"Tab inserts a tab or moves to the next table cell. Press Escape to leave the editor."
			)
			cleanup()

			await openEditor("01-plain.docx", false)
			expect(screen.getAllByRole("textbox")[0]?.hasAttribute("aria-describedby")).toBe(false)
			expect(screen.queryByText(/Press Escape to leave the editor/)).toBeNull()
			cleanup()
		}
	})

	it("leaves the context menu, a paste and a drop in the review layer to it", async () => {
		await openEditor("01-plain.docx")

		const surface = screen.getByRole("textbox", { name: "report.docx" }).closest("[data-preview-surface]")
		const field = document.createElement("textarea")
		const balloon = document.createElement("div")

		balloon.setAttribute("data-docx-review", "")
		balloon.append(field)
		surface?.append(balloon)

		fireEvent.contextMenu(field)
		fireEvent.paste(field)
		fireEvent.drop(field)
		await act(() => new Promise(resolve => setTimeout(resolve, 20)))
		expect(screen.queryByRole("menuitem", { name: "Select all" })).toBeNull()
		expect(hooks.paste).not.toHaveBeenCalled()
		expect(hooks.drop).not.toHaveBeenCalled()

		// Elsewhere they are the editor's. A browser's paste carries the clipboard: one without it sends ProseMirror to
		// its legacy capture, a timer that would outlive the test.
		const timers = vi.spyOn(globalThis, "setTimeout")
		const paste = createEvent.paste(screen.getByRole("textbox", { name: "report.docx" }), {
			clipboardData: { types: ["text/plain"], getData: (type: string) => (type === "text/plain" ? "pasted" : "") }
		})

		fireEvent(screen.getByRole("textbox", { name: "report.docx" }), paste)
		expect(hooks.paste).toHaveBeenCalledTimes(1)
		expect(paste.defaultPrevented).toBe(true)
		expect(timers.mock.calls.filter(call => call[1] === 50)).toEqual([])
		timers.mockRestore()
		fireEvent.contextMenu(screen.getByRole("textbox", { name: "report.docx" }))
		expect(await screen.findByRole("menuitem", { name: "Select all" })).toBeTruthy()
	})
})
