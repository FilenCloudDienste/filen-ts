// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen } from "@testing-library/react"
import type { PdfViewerState } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { usePdfCommandParts } from "@/features/preview/components/pdfCommandParts"
import { usePdfScrollRoom } from "@/features/preview/hooks/usePdfScrollRoom"
import { pdfPageCommandEnabled, pdfScrollRoom, PDF_SCROLL_ROOM_ANY, type PdfScrollRoom } from "@/features/preview/lib/pdfScrollRoom.logic"
import "@/lib/i18n"

// A page step needs room for the page column to scroll that way: where every page is in view, or the column is at
// that end, Next or Previous page is off and the page shown stays the one most in view.

const STATE: PdfViewerState = {
	page: 2,
	pageCount: 3,
	scale: 1.5,
	zoom: 100,
	zoomMode: "custom",
	rotation: 0,
	find: { open: false, query: "", caseSensitive: false, done: true, count: 0, capped: false, active: -1 }
}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe("pdfScrollRoom", () => {
	it("reads the room either way from the scroll position", () => {
		expect(pdfScrollRoom(0, 900, 900)).toEqual({ back: false, forward: false })
		expect(pdfScrollRoom(0, 900, 5400)).toEqual({ back: false, forward: true })
		expect(pdfScrollRoom(2000, 900, 5400)).toEqual({ back: true, forward: true })
		expect(pdfScrollRoom(4500, 900, 5400)).toEqual({ back: true, forward: false })
		// A fraction of a pixel from an end is at it.
		expect(pdfScrollRoom(0.5, 900, 900.5)).toEqual({ back: false, forward: false })
	})

	it("keeps a page step to its own rule, and its room", () => {
		expect(pdfPageCommandEnabled(STATE, "page.next", { back: true, forward: false })).toBe(false)
		expect(pdfPageCommandEnabled(STATE, "page.last", { back: true, forward: false })).toBe(false)
		expect(pdfPageCommandEnabled(STATE, "page.previous", { back: false, forward: true })).toBe(false)
		expect(pdfPageCommandEnabled(STATE, "page.first", { back: false, forward: true })).toBe(false)
		expect(pdfPageCommandEnabled({ ...STATE, page: 3 }, "page.next", PDF_SCROLL_ROOM_ANY)).toBe(false)
		expect(pdfPageCommandEnabled(STATE, "zoom.in", { back: false, forward: false })).toBe(true)
	})
})

describe("usePdfScrollRoom", () => {
	function column(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }): HTMLDivElement {
		const scroller = document.createElement("div")

		scroller.append(document.createElement("div"))

		for (const key of ["scrollTop", "clientHeight", "scrollHeight"] as const) {
			Object.defineProperty(scroller, key, { configurable: true, get: () => metrics[key] })
		}

		return scroller
	}

	it("follows the column as it scrolls and resizes, once a frame", () => {
		const frames: FrameRequestCallback[] = []
		const resized: ResizeObserverCallback[] = []
		const observed: Element[] = []

		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: ResizeObserverCallback) {
					resized.push(callback)
				}

				observe(element: Element): void {
					observed.push(element)
				}

				disconnect(): void {
					// Nothing held.
				}
			}
		)

		const metrics = { scrollTop: 0, clientHeight: 900, scrollHeight: 900 }
		const scroller = column(metrics)
		const ref = { current: scroller }
		const { result } = renderHook(() => usePdfScrollRoom(ref))
		const flush = (): void => {
			act(() => {
				for (const frame of frames.splice(0)) frame(0)
			})
		}

		// The scroller and its column are watched; nothing is measured until the frame.
		expect(observed).toEqual([scroller, scroller.firstElementChild])
		expect(result.current).toEqual(PDF_SCROLL_ROOM_ANY)
		flush()
		expect(result.current).toEqual({ back: false, forward: false })

		// The pages sized: the column now scrolls. Two signals in a frame measure once.
		metrics.scrollHeight = 5400
		act(() => {
			resized[0]?.([], {} as ResizeObserver)
			scroller.dispatchEvent(new Event("scroll"))
		})
		expect(frames).toHaveLength(1)
		flush()
		expect(result.current).toEqual({ back: false, forward: true })

		metrics.scrollTop = 4500
		act(() => {
			scroller.dispatchEvent(new Event("scroll"))
		})
		flush()
		expect(result.current).toEqual({ back: true, forward: false })
	})
})

describe("the page commands", () => {
	function pages(room: PdfScrollRoom): void {
		const { result } = renderHook(() =>
			usePdfCommandParts({
				state: STATE,
				dispatch: () => undefined,
				document: {} as PdfDomDocument,
				outline: [],
				findFocus: 0,
				onFindClosed: () => undefined,
				onDownload: null,
				onPrint: undefined,
				onProperties: () => undefined,
				pageInputRef: { current: null },
				scrollRoom: room
			})
		)

		render(<>{result.current.groups.find(group => group.id === "pages")?.content}</>)
	}

	function disabled(name: string): boolean {
		return screen.getByRole<HTMLButtonElement>("button", { name }).disabled
	}

	it("turns Next and Previous page off where the column cannot scroll that way", () => {
		pages({ back: false, forward: false })
		expect(disabled("Next page")).toBe(true)
		expect(disabled("Previous page")).toBe(true)
		cleanup()

		pages({ back: true, forward: true })
		expect(disabled("Next page")).toBe(false)
		expect(disabled("Previous page")).toBe(false)
	})
})
