// @vitest-environment jsdom

import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { OpenInfo, PresentationSessionApi } from "@filen/office/dom/presentation"

// Mod+P over an open deck: Print where it is offered, taken anyway where it is not (the browser's own print never
// runs from the keyboard), with a notice where downloads are disallowed; while a deck is open, the print stylesheet
// hides the app from the browser's own print.

const mocks = vi.hoisted(() => ({
	toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn(), info: vi.fn() }),
	printDeck: vi.fn(() => Promise.resolve())
}))

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/keymap/registry", () => ({ isRecordingCombo: () => false, useComboFor: () => "mod+p" }))
vi.mock("@/features/presentation/print/printDeck", () => ({ printDeck: mocks.printDeck }))

const { usePresentationPrintKey } = await import("@/features/presentation/print/usePresentationPrint")
const { PreviewDownloadableProvider } = await import("@/features/preview/lib/accessMode")
await import("@/lib/i18n")

const SESSION = {} as PresentationSessionApi
const INFO = { slides: [{ ref: 1, hidden: false }], size: { cx: 9144000, cy: 5143500 } } as unknown as OpenInfo

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

describe("Mod+P over an open deck", () => {
	it("prints the shown slides where downloads are allowed, the browser's print never running", () => {
		renderHook(
			() => {
				usePresentationPrintKey(SESSION, INFO)
			},
			{ wrapper: wrapper(true) }
		)

		expect(pressModP().defaultPrevented).toBe(true)
		expect(mocks.printDeck).toHaveBeenCalledOnce()
		expect(mocks.toast.info).not.toHaveBeenCalled()
	})

	it("is taken and refused with a notice where downloads are disallowed", () => {
		renderHook(
			() => {
				usePresentationPrintKey(SESSION, INFO)
			},
			{ wrapper: wrapper(false) }
		)

		expect(pressModP().defaultPrevented).toBe(true)
		expect(mocks.printDeck).not.toHaveBeenCalled()
		expect(mocks.toast.info).toHaveBeenCalledWith("The link's owner doesn't allow downloads, so the slides can't be printed.")
	})

	it("is taken while the deck is still opening", () => {
		renderHook(
			() => {
				usePresentationPrintKey(undefined, undefined)
			},
			{ wrapper: wrapper(true) }
		)

		expect(pressModP().defaultPrevented).toBe(true)
		expect(mocks.printDeck).not.toHaveBeenCalled()
	})

	it("marks the document while a deck is open, for the print stylesheet", () => {
		const hook = renderHook(
			() => {
				usePresentationPrintKey(SESSION, INFO)
			},
			{ wrapper: wrapper(false) }
		)

		expect(document.documentElement.hasAttribute("data-fo-pptx-open")).toBe(true)
		hook.unmount()
		expect(document.documentElement.hasAttribute("data-fo-pptx-open")).toBe(false)
	})
})
