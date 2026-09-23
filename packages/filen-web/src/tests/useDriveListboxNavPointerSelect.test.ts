// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MouseEvent as ReactMouseEvent } from "react"
import { act, renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"

// Same mock boundary as useDriveListboxNavReveal.test.ts: the DriveVirtualizer type's module graph
// reaches the Vite `?worker` client, unresolvable under vitest.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useDriveListboxNav } from "@/features/drive/hooks/useDriveListboxNav"
import type { DriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

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

function click(
	init: { detail?: number; shiftKey?: boolean; ctrlKey?: boolean; pointerType?: string } = {}
): ReactMouseEvent<HTMLDivElement> {
	return {
		shiftKey: init.shiftKey ?? false,
		metaKey: false,
		ctrlKey: init.ctrlKey ?? false,
		detail: init.detail ?? 1,
		nativeEvent: init.pointerType === undefined ? {} : { pointerType: init.pointerType }
	} as ReactMouseEvent<HTMLDivElement>
}

const first = item("a")
const items = [first, item("b"), item("c")]

function renderNav() {
	const virtualizer = { scrollToIndex: vi.fn() } as unknown as DriveVirtualizer["activeVirtualizer"]
	const itemRefs = { current: new Map<number, HTMLDivElement>() } as DriveVirtualizer["itemRefs"]

	return renderHook(() =>
		useDriveListboxNav({
			items,
			viewMode: "list",
			columns: 1,
			virtualizer,
			itemRefs,
			variant: "drive",
			splat: "",
			onOpen: vi.fn()
		})
	)
}

function selectedLabels(): string[] {
	return useDriveStore.getState().selectedItems.map(selected => selected.data.uuid.slice(0, 1))
}

beforeEach(() => {
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
})

describe("useDriveListboxNav — plain click", () => {
	it("selects an unselected item, then a second plain click deselects it", () => {
		const { result } = renderNav()

		act(() => {
			result.current.handlePointerSelect(1, click())
		})
		expect(selectedLabels()).toEqual(["b"])

		act(() => {
			result.current.handlePointerSelect(1, click())
		})
		expect(selectedLabels()).toEqual([])
		// The cursor stays on the item, as a click puts it there.
		expect(result.current.safeActiveIndex).toBe(1)
	})

	it("keeps an unselected item selected across a double-click (detail 1 then 2)", () => {
		const { result } = renderNav()

		act(() => {
			result.current.handlePointerSelect(2, click({ detail: 1 }))
		})
		act(() => {
			result.current.handlePointerSelect(2, click({ detail: 2 }))
		})

		expect(selectedLabels()).toEqual(["c"])
	})

	it("ends a double-click on the sole selected item with it still selected", () => {
		useDriveStore.setState({ selectedItems: [first] })
		const { result } = renderNav()

		act(() => {
			result.current.handlePointerSelect(0, click({ detail: 1 }))
		})
		act(() => {
			result.current.handlePointerSelect(0, click({ detail: 2 }))
		})

		expect(selectedLabels()).toEqual(["a"])
	})

	it("narrows a multi-selection to the clicked item", () => {
		const { result } = renderNav()

		act(() => {
			result.current.handlePointerSelect(0, click())
		})
		act(() => {
			result.current.handlePointerSelect(2, click({ shiftKey: true }))
		})
		expect(selectedLabels()).toEqual(["a", "b", "c"])

		act(() => {
			result.current.handlePointerSelect(1, click())
		})
		expect(selectedLabels()).toEqual(["b"])
	})

	it("ctrl-click still toggles membership", () => {
		const { result } = renderNav()

		act(() => {
			result.current.handlePointerSelect(0, click())
		})
		act(() => {
			result.current.handlePointerSelect(1, click({ ctrlKey: true }))
		})
		expect(selectedLabels()).toEqual(["a", "b"])

		act(() => {
			result.current.handlePointerSelect(0, click({ ctrlKey: true }))
		})
		expect(selectedLabels()).toEqual(["b"])
	})

	it("keeps a touch tap on the sole selected item selected", () => {
		const { result } = renderNav()

		act(() => {
			result.current.handlePointerSelect(0, click({ pointerType: "touch" }))
		})
		act(() => {
			result.current.handlePointerSelect(0, click({ pointerType: "touch" }))
		})

		expect(selectedLabels()).toEqual(["a"])
	})
})
