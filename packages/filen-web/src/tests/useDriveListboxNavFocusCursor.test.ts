// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveListboxNav } from "@/features/drive/hooks/useDriveListboxNav"
import type { DriveViewMode } from "@/features/drive/lib/preferences"
import type { DriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"
import { testUuid } from "@/tests/support/uuid"

// drive.focusListing re-registers when focusCursor changes: a view-mode or column change must hand it a
// focusCursor bound to the new virtualizer and column count, with the cursor and items unchanged.

function item(label: string): DriveItem {
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

function stubVirtualizer() {
	const scrollToIndex = vi.fn()

	return { scrollToIndex, virtualizer: { scrollToIndex } as unknown as DriveVirtualizer["activeVirtualizer"] }
}

describe("useDriveListboxNav — focusCursor", () => {
	it("follows a view-mode and column change: the new focusCursor scrolls the grid virtualizer by grid row", () => {
		const items = ["a", "b", "c", "d", "e", "f", "g"].map(item)
		const list = stubVirtualizer()
		const grid = stubVirtualizer()
		const itemRefs: DriveVirtualizer["itemRefs"] = { registerRef: vi.fn(), focusItem: vi.fn() }

		const { result, rerender } = renderHook(
			(props: { viewMode: DriveViewMode; columns: number; virtualizer: DriveVirtualizer["activeVirtualizer"] }) =>
				useDriveListboxNav({
					items,
					viewMode: props.viewMode,
					columns: props.columns,
					virtualizer: props.virtualizer,
					itemRefs,
					variant: "drive",
					splat: "a",
					onOpen: vi.fn()
				}),
			{ initialProps: { viewMode: "list", columns: 1, virtualizer: list.virtualizer } }
		)

		act(() => {
			result.current.setCursor(5)
		})

		const listFocus = result.current.focusCursor

		listFocus()
		expect(list.scrollToIndex).toHaveBeenLastCalledWith(5, { align: "auto" })
		expect(itemRefs.focusItem).toHaveBeenLastCalledWith(5)

		rerender({ viewMode: "grid", columns: 3, virtualizer: grid.virtualizer })

		expect(result.current.safeActiveIndex).toBe(5)
		expect(result.current.focusCursor).not.toBe(listFocus)

		result.current.focusCursor()
		expect(grid.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "auto" })
		expect(itemRefs.focusItem).toHaveBeenLastCalledWith(5)

		rerender({ viewMode: "grid", columns: 2, virtualizer: grid.virtualizer })
		result.current.focusCursor()
		expect(grid.scrollToIndex).toHaveBeenLastCalledWith(2, { align: "auto" })
		expect(list.scrollToIndex).toHaveBeenCalledOnce()
	})
})
