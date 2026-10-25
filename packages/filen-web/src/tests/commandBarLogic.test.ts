// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import {
	pageControlsWidth,
	toggleViewerFullScreen,
	typedPage,
	useLeaveViewerFullScreen
} from "@/features/preview/components/commandBar.logic"

// The command bars' page field and full screen: a typed page clamped into the document, and full screen left once no
// document viewer is open, kept while paging from one to the next.

describe("typedPage", () => {
	it("clamps a typed page into the document and ignores what is no number", () => {
		expect(typedPage("3", 10)).toBe(3)
		expect(typedPage("0", 10)).toBe(1)
		expect(typedPage("99", 10)).toBe(10)
		expect(typedPage("", 10)).toBeNull()
		expect(typedPage("5", 0)).toBeNull()
	})

	it("estimates the page group with and without first and last", () => {
		expect(pageControlsWidth(true) - pageControlsWidth(false)).toBe(60)
	})
})

describe("viewer full screen", () => {
	afterEach(() => {
		Reflect.deleteProperty(document, "fullscreenElement")
	})

	function fullscreen(): ReturnType<typeof vi.fn> {
		const exit = vi.fn(() => Promise.resolve())

		Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null, writable: true })
		document.documentElement.requestFullscreen = vi.fn(() => {
			Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement, writable: true })

			return Promise.resolve()
		})
		document.exitFullscreen = exit

		return exit
	}

	it("keeps full screen while paging to the next viewer and leaves it once the last closes", async () => {
		const exit = fullscreen()
		const first = renderHook(() => {
			useLeaveViewerFullScreen()
		})

		await toggleViewerFullScreen()

		// Paging: the next viewer mounts as the first unmounts.
		const next = renderHook(() => {
			useLeaveViewerFullScreen()
		})

		first.unmount()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()

		next.unmount()
		await Promise.resolve()
		expect(exit).toHaveBeenCalledTimes(1)
	})

	it("leaves a full screen it did not ask for alone", async () => {
		const exit = fullscreen()

		await document.documentElement.requestFullscreen()

		const viewer = renderHook(() => {
			useLeaveViewerFullScreen()
		})

		viewer.unmount()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()
	})
})
