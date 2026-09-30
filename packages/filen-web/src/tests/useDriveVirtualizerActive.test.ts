// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { Dir } from "@filen/sdk-rs"

// The thumbnail service reaches the Vite `?worker` client, unresolvable under vitest.
vi.mock("@/features/drive/lib/thumbnails", () => ({ setThumbnailViewport: vi.fn() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"
import { ROW_HEIGHT } from "@/features/drive/lib/gridLayout"
import { testUuid } from "@/tests/support/uuid"
import type { DriveViewMode } from "@/features/drive/lib/preferences"

function directoryItem(label: string): DriveItem {
	const dir: Dir = {
		uuid: testUuid(label),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}

	return narrowItem(dir)
}

// jsdom has no layout: give the scroll element a real viewport height and a settable scrollTop.
function scrollContainer(scrollTop: number): HTMLDivElement {
	const element = document.createElement("div")
	let top = scrollTop

	Object.defineProperty(element, "offsetHeight", { configurable: true, value: 400 })
	Object.defineProperty(element, "offsetWidth", { configurable: true, value: 800 })
	Object.defineProperty(element, "scrollTop", {
		configurable: true,
		get: () => top,
		set: (value: number) => {
			top = value
		}
	})
	document.body.appendChild(element)

	return element
}

const items = Array.from({ length: 200 }, (_, index) => directoryItem(String(index)))

describe("useDriveVirtualizer active instance", () => {
	afterEach(() => {
		document.body.replaceChildren()
	})

	it("attaches only the active virtualizer to the scroll element", () => {
		const { result, rerender } = renderHook(({ mode }: { mode: DriveViewMode }) => useDriveVirtualizer(items, mode), {
			initialProps: { mode: "grid" }
		})
		const element = scrollContainer(0)

		act(() => {
			result.current.setScrollElement(element)
		})

		expect(result.current.gridVirtualizer.scrollElement).toBe(element)
		expect(result.current.listVirtualizer.scrollElement).toBeNull()

		rerender({ mode: "list" })

		expect(result.current.listVirtualizer.scrollElement).toBe(element)
		expect(result.current.gridVirtualizer.scrollElement).toBeNull()
	})

	// A re-enabled instance reads no offset when it attaches, so it must start from where the shared element
	// was scrolled while it was inactive.
	it("starts a re-enabled virtualizer from the element's current scroll position", () => {
		const { result, rerender } = renderHook(({ mode }: { mode: DriveViewMode }) => useDriveVirtualizer(items, mode), {
			initialProps: { mode: "grid" }
		})
		const element = scrollContainer(0)

		act(() => {
			result.current.setScrollElement(element)
		})

		element.scrollTop = ROW_HEIGHT * 50

		act(() => {
			element.dispatchEvent(new Event("scroll"))
		})

		rerender({ mode: "list" })

		expect(result.current.listVirtualizer.scrollOffset).toBe(ROW_HEIGHT * 50)
		expect(result.current.listVirtualizer.getVirtualItems().some(row => row.index === 50)).toBe(true)
		expect(result.current.listVirtualizer.getVirtualItems().some(row => row.index === 0)).toBe(false)
	})
})
