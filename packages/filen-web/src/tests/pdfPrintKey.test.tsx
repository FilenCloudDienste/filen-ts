// @vitest-environment jsdom

import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { PdfDomDocument } from "@filen/office/react/pdf"

// Mod+P over a PDF: the print dialog where printing is offered, taken anyway where it is not (the browser's own print
// never runs from the keyboard), with a notice saying why.

const mocks = vi.hoisted(() => ({
	toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn(), info: vi.fn() })
}))

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/keymap/registry", () => ({ isRecordingCombo: () => false, useComboFor: () => "mod+p" }))

const { usePdfPrint } = await import("@/features/pdf/print/usePdfPrint")
const { PreviewDownloadableProvider } = await import("@/features/preview/lib/accessMode")
await import("@/lib/i18n")

function documentWith(flags: ReadonlySet<number> | null): PdfDomDocument {
	return {
		numPages: 3,
		getPermissions: () => Promise.resolve(flags)
	} as unknown as PdfDomDocument
}

function pressModP(): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: "p", code: "KeyP", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true })

	document.body.dispatchEvent(event)

	return event
}

function wrapper(downloadable: boolean) {
	return ({ children }: { children: ReactNode }) => createElement(PreviewDownloadableProvider, { downloadable, children })
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	document.body.replaceChildren()
})

describe("Mod+P over a PDF", () => {
	it("opens the print dialog where printing is offered", async () => {
		const pdf = documentWith(null)
		const { result } = renderHook(() => usePdfPrint({ document: pdf, current: 1, size: 1000 }), { wrapper: wrapper(true) })

		await waitFor(() => {
			expect(result.current.open).toBeDefined()
		})
		act(() => {
			expect(pressModP().defaultPrevented).toBe(true)
		})
		expect(result.current.dialog).not.toBeNull()
		expect(mocks.toast.info).not.toHaveBeenCalled()
	})

	it("is taken and refused with a notice where downloads are disallowed", async () => {
		const pdf = documentWith(null)
		const { result } = renderHook(() => usePdfPrint({ document: pdf, current: 1, size: 1000 }), { wrapper: wrapper(false) })

		await act(() => Promise.resolve())
		expect(pressModP().defaultPrevented).toBe(true)
		expect(result.current.open).toBeUndefined()
		expect(mocks.toast.info).toHaveBeenCalledWith("The link's owner doesn't allow downloads, so this PDF can't be printed.")
	})

	it("is taken and refused with a notice where the author turned printing off", async () => {
		const pdf = documentWith(new Set([0x10]))
		const { result } = renderHook(() => usePdfPrint({ document: pdf, current: 1, size: 1000 }), {
			wrapper: wrapper(true)
		})

		await waitFor(() => {
			expect(pressModP().defaultPrevented).toBe(true)
			expect(mocks.toast.info).toHaveBeenCalledWith("The document's author doesn't allow printing it.")
		})
		expect(result.current.open).toBeUndefined()
	})
})
