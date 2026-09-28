// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MouseEvent as ReactMouseEvent } from "react"
import { act, renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, SharedFile, UuidStr } from "@filen/sdk-rs"

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

// The Shared by me root lists one item once per receiver: same uuid, a different counterpart per row.
function receiverRow(receiverId: number): DriveItem {
	const file: SharedFile = {
		uuid: testUuid("shared"),
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "Report", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: { Receiver: { email: `${String(receiverId)}@x.com`, id: receiverId } },
		sharedTag: true,
		canMakeThumbnail: false
	}

	return narrowItem(file)
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

function renderNav(listItems: DriveItem[] = items) {
	const virtualizer = { scrollToIndex: vi.fn() } as unknown as DriveVirtualizer["activeVirtualizer"]
	const itemRefs = { current: new Map<number, HTMLDivElement>() } as DriveVirtualizer["itemRefs"]

	return renderHook(() =>
		useDriveListboxNav({
			items: listItems,
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

describe("useDriveListboxNav — one shared item's per-receiver rows", () => {
	const bob = receiverRow(1)
	const carol = receiverRow(2)

	function selectedReceivers(): number[] {
		return useDriveStore
			.getState()
			.selectedItems.map(selected =>
				selected.type === "sharedRootFile" && "Receiver" in selected.data.sharingRole ? selected.data.sharingRole.Receiver.id : -1
			)
	}

	it("moves a plain-click selection to the other receiver's row, with the cursor on it", () => {
		const { result } = renderNav([bob, carol])

		act(() => {
			result.current.handlePointerSelect(0, click())
		})
		act(() => {
			result.current.handlePointerSelect(1, click())
		})

		expect(selectedReceivers()).toEqual([2])
		expect(result.current.safeActiveIndex).toBe(1)
	})

	it("ctrl-click toggles each receiver's row on its own", () => {
		const { result } = renderNav([bob, carol])

		act(() => {
			result.current.handlePointerSelect(0, click({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(1, click({ ctrlKey: true }))
		})
		expect(selectedReceivers()).toEqual([1, 2])

		act(() => {
			result.current.handlePointerSelect(0, click({ ctrlKey: true }))
		})
		expect(selectedReceivers()).toEqual([2])
		expect(result.current.safeActiveIndex).toBe(0)
	})

	it("extends a shift range from the receiver row the anchor is on", () => {
		const { result } = renderNav([bob, carol, first])

		act(() => {
			result.current.handlePointerSelect(1, click())
		})
		act(() => {
			result.current.handlePointerSelect(2, click({ shiftKey: true }))
		})

		expect(selectedReceivers()).toEqual([2, -1])
	})
})
