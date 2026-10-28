// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

const bridge = vi.hoisted(() => ({ current: undefined as object | undefined }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => bridge.current }))

import { SuspendDragRegions } from "@/components/ui/suspendDragRegions"

function flagged(): boolean {
	return document.documentElement.hasAttribute("data-popover-open")
}

afterEach(() => {
	cleanup()
	bridge.current = undefined
})

describe("SuspendDragRegions", () => {
	it("flags the document while a popover is mounted on desktop", () => {
		bridge.current = {}

		const { unmount } = render(<SuspendDragRegions />)

		expect(flagged()).toBe(true)

		unmount()

		expect(flagged()).toBe(false)
	})

	it("keeps the flag until the last of several open popovers closes", () => {
		bridge.current = {}

		const first = render(<SuspendDragRegions />)
		const second = render(<SuspendDragRegions />)

		first.unmount()

		expect(flagged()).toBe(true)

		second.unmount()

		expect(flagged()).toBe(false)
	})

	it("leaves the document alone in a browser", () => {
		render(<SuspendDragRegions />)

		expect(flagged()).toBe(false)
	})
})
