// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { isValidElement, type ReactNode } from "react"
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

function setup(mode: "edit" | "add", textHit: (args: { page: number; point: readonly number[] }) => Promise<unknown>) {
	const calls: unknown[] = []
	const notices: ReactNode[] = []
	const session = {
		engine: {
			call: (op: string, args: { page: number; point: readonly number[] }) => {
				calls.push([op, args])

				return op === "textHit" ? textHit(args) : Promise.resolve(null)
			}
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
