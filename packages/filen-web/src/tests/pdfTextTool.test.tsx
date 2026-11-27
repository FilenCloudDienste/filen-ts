// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { isValidElement, type ReactNode } from "react"
import { matchPdfFont } from "@filen/office/core/pdfedit/fontMatch"
import { PdfEngineError, TEXT_EDIT_UNSAFE } from "@filen/office/dom/pdfedit"
import { PageViewport, type PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { fakeToolContext } from "@/tests/support/pdfToolContext"

// Tools › Edit text and Add text from the keyboard: each page is a focusable target; Enter puts the marker (or the new
// text's box) down, the arrows move it and Enter uses it. A spot without text and a failed read are told, never silent.

vi.mock("react-i18next", async importOriginal => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
	})
}))

const toastError = vi.fn()
const logError = vi.fn()

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/lib/keymap/kbd.logic", () => ({ isMacPlatform: () => false }))

const { AddTextOverlay, EditTextOverlay, TextToolPanel } = await import("@/features/pdf/textEdit/textEditTool")
const { PdfLiveRegion } = await import("@/features/pdf/tools/pdfLiveRegion")

const VIEWPORT = new PageViewport({ viewBox: [0, 0, 600, 800], scale: 1, rotation: 0 })

function setup(
	mode: "edit" | "add",
	textHit: (args: { page: number; point: readonly number[] }) => Promise<unknown>,
	textPrepare: () => Promise<unknown> = () => Promise.resolve(null),
	textPreview: () => Promise<unknown> = () => Promise.resolve({ status: "busy" })
) {
	const calls: unknown[] = []
	const notices: ReactNode[] = []
	const session = {
		engine: {
			call: (op: string, args: { page: number; point: readonly number[] }) => {
				calls.push([op, args])

				if (op === "textPrepare") return textPrepare()
				if (op === "textPreview") return textPreview()

				return op === "textHit" ? textHit(args) : Promise.resolve(null)
			}
		},
		dispatch: (command: string, args: unknown) => {
			calls.push([command, args])

			return Promise.resolve({})
		},
		getSnapshot: () => ({ state: { tagged: false } })
	} as unknown as PdfEditSessionModel
	const context = fakeToolContext({
		edit: (change, dropped) => {
			void change(session).catch(() => dropped?.())
		},
		notify: notice => {
			notices.push(notice)
		}
	})
	const Overlay = mode === "add" ? AddTextOverlay : EditTextOverlay

	render(
		<div>
			<PdfLiveRegion owner={context.swap} />
			<TextToolPanel
				context={context}
				document={{} as PdfDomDocument}
				active
				phone={false}
			/>
			<Overlay
				context={context}
				page={2}
				viewport={VIEWPORT}
				widgets={null}
				editing
				document={{} as PdfDomDocument}
				variant={null}
			/>
		</div>
	)

	return { calls, notices }
}

const noticeKinds = (notices: readonly ReactNode[]): unknown[] =>
	notices.filter(isValidElement).map(notice => (notice.props as { kind?: unknown }).kind)

describe("text tools from the keyboard", () => {
	it("edits the text under the marker placed with Enter and the arrows", async () => {
		const { calls } = setup("edit", () => Promise.resolve({ kind: "none" }))
		const page = screen.getByRole("application", { name: 'previewPdfTextEditOnPage {"page":3}' })

		expect(page.tabIndex).toBe(0)
		expect(document.getElementById(page.getAttribute("aria-describedby") ?? "")?.textContent).toBe("previewPdfTextEditPlaceHint")

		act(() => {
			page.focus()
		})
		fireEvent.keyDown(page, { key: "Enter" })
		await waitFor(() => {
			expect(screen.getByRole("status").textContent).toContain("previewPdfPlacementPosition")
		})
		fireEvent.keyDown(page, { key: "ArrowUp", shiftKey: true })
		fireEvent.keyDown(page, { key: "Enter" })

		// The marker's centre: the page centre, 10 pt up (display space, y down).
		await waitFor(() => {
			expect(calls).toContainEqual(["textHit", { page: 2, point: [300, 390] }])
		})
	})

	it("says there is no text where the marker was used", async () => {
		const { notices } = setup("edit", () => Promise.resolve({ kind: "none" }))
		const page = screen.getByRole("application")

		fireEvent.keyDown(page, { key: "Enter" })
		fireEvent.keyDown(page, { key: "Enter" })

		await waitFor(() => {
			expect(noticeKinds(notices)).toContain("noText")
		})
	})

	it("tells and logs a hit test that failed", async () => {
		const failure = new Error("engine trap")

		setup("edit", () => Promise.reject(failure))

		const page = screen.getByRole("application")

		fireEvent.keyDown(page, { key: "Enter" })
		fireEvent.keyDown(page, { key: "Enter" })

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("previewPdfTextEditHitFailed")
		})
		expect(logError).toHaveBeenCalledWith("pdf", expect.any(String), { error: failure })
	})

	it("opens the new text's editor where its box was placed", async () => {
		setup("add", () => Promise.resolve({ kind: "none" }))

		const page = screen.getByRole("application", { name: 'previewPdfTextAddOnPage {"page":3}' })

		fireEvent.keyDown(page, { key: "Enter" })
		fireEvent.keyDown(page, { key: "Enter" })

		await waitFor(() => {
			expect(screen.getByRole("textbox", { name: "previewPdfTextEditField" })).toBeTruthy()
		})
	})
})

describe("applying a text edit", () => {
	// Add text's editor opened from the keyboard, the text typed and Done pressed.
	async function typeAndApply(text: string): Promise<HTMLTextAreaElement> {
		const page = screen.getByRole("application")

		fireEvent.keyDown(page, { key: "Enter" })
		fireEvent.keyDown(page, { key: "Enter" })

		const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "previewPdfTextEditField" })

		fireEvent.input(field, { target: { value: text } })
		fireEvent.click(screen.getByRole("button", { name: "previewPdfTextEditDone" }))

		return field
	}

	it.each([
		["refused as unsafe", () => Promise.reject(new PdfEngineError("notAllowed", TEXT_EDIT_UNSAFE)), "unsafe"],
		["failed", () => Promise.reject(new Error("engine trap")), null]
	])("keeps the editor open with the typed text when the edit is %s", async (_name, prepare, notice) => {
		toastError.mockClear()

		const { notices } = setup("add", () => Promise.resolve({ kind: "none" }), prepare)
		const field = await typeAndApply("A rewritten paragraph")

		await waitFor(() => {
			if (notice === null) expect(toastError).toHaveBeenCalledWith("previewPdfChangeFailed")
			else expect(noticeKinds(notices)).toContain(notice)
		})
		await waitFor(() => {
			expect(screen.getByRole<HTMLButtonElement>("button", { name: "previewPdfTextEditDone" }).disabled).toBe(false)
		})
		expect(screen.getByRole("textbox", { name: "previewPdfTextEditField" })).toBe(field)
		expect(field.value).toBe("A rewritten paragraph")
		expect(field.readOnly).toBe(false)
	})

	it("closes the editor once the edit was made", async () => {
		const { calls } = setup(
			"add",
			() => Promise.resolve({ kind: "none" }),
			() => Promise.resolve({})
		)

		await typeAndApply("New text")
		await waitFor(() => {
			expect(screen.queryByRole("textbox", { name: "previewPdfTextEditField" })).toBeNull()
		})
		expect(calls.some(call => (call as unknown[])[0] === "textEdit.add")).toBe(true)
	})

	it("leaves no refusal notice once a retry after an unsafe refusal was made", async () => {
		let refuse = true
		const { notices } = setup(
			"add",
			() => Promise.resolve({ kind: "none" }),
			() => (refuse ? Promise.reject(new PdfEngineError("notAllowed", TEXT_EDIT_UNSAFE)) : Promise.resolve({}))
		)
		const field = await typeAndApply("Too much")

		await waitFor(() => {
			expect(noticeKinds(notices)).toContain("unsafe")
		})
		await waitFor(() => {
			expect(screen.getByRole<HTMLButtonElement>("button", { name: "previewPdfTextEditDone" }).disabled).toBe(false)
		})

		refuse = false
		fireEvent.input(field, { target: { value: "Just right" } })
		fireEvent.click(screen.getByRole("button", { name: "previewPdfTextEditDone" }))

		await waitFor(() => {
			expect(screen.queryByRole("textbox", { name: "previewPdfTextEditField" })).toBeNull()
		})
		expect(notices.at(-1)).toBeNull()
	})
})

describe("the page under the text editor", () => {
	const TARGET = {
		text: "Hello",
		chars: [{ c: "H", x: 72, y: 120, quad: [72, 111, 80, 111, 72, 123, 80, 123] }],
		offsets: [0],
		frame: { origin: [72, 120], direction: [1, 0], width: null, lineHeight: 14 },
		bounds: [72, 111, 100, 123],
		angle: 0,
		size: 12,
		color: 0,
		font: matchPdfFont({ name: "Helvetica", bold: false, italic: false, serif: false, mono: false }),
		fontName: "Helvetica",
		pageWidth: 600,
		pageHeight: 800
	}

	class FakeBitmap {
		readonly width = 64
		readonly height = 32
		readonly close = vi.fn()
	}

	function openEditor(preview: () => Promise<unknown>) {
		const result = setup("edit", () => Promise.resolve({ kind: "target", target: TARGET }), undefined, preview)
		const page = screen.getByRole("application")

		fireEvent.keyDown(page, { key: "Enter" })
		fireEvent.keyDown(page, { key: "Enter" })

		return result
	}

	it("draws the page without the text under a clear editor, and drops it when the editor closes", async () => {
		vi.stubGlobal("ImageBitmap", FakeBitmap)

		const bitmap = new FakeBitmap()
		const { calls } = openEditor(() => Promise.resolve({ status: "clean", bitmap, tile: [140, 218, 204, 250], scale: 2 }))
		const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "previewPdfTextEditField" })
		const patch = document.querySelector<HTMLCanvasElement>("[data-slot=pdf-text-patch]")

		expect(calls).toContainEqual(["textPreview", { page: 2, chars: TARGET.chars, rect: TARGET.bounds, scale: window.devicePixelRatio }])
		// Drawn at 2 device px per point, shown at the view's 1 CSS px per point.
		expect(patch?.style.left).toBe("70px")
		expect(patch?.style.width).toBe("32px")
		expect(field.className).toContain("bg-transparent")

		fireEvent.keyDown(field, { key: "Escape" })
		await waitFor(() => {
			expect(document.querySelector("[data-slot=pdf-text-patch]")).toBeNull()
		})
		expect(bitmap.close).toHaveBeenCalled()
		vi.unstubAllGlobals()
	})

	it("refuses text Done would refuse before the editor opens", async () => {
		const { notices } = openEditor(() => Promise.resolve({ status: "unsafe" }))

		await waitFor(() => {
			expect(noticeKinds(notices)).toContain("unsafe")
		})
		expect(screen.queryByRole("textbox", { name: "previewPdfTextEditField" })).toBeNull()
	})

	it("opens a veiled editor when the page could not be drawn", async () => {
		openEditor(() => Promise.resolve({ status: "busy" }))

		const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "previewPdfTextEditField" })

		expect(field.className).toContain("bg-background/80")
		expect(document.querySelector("[data-slot=pdf-text-patch]")).toBeNull()
	})
})
