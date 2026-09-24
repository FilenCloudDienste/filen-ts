// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
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

function item(label: string): DriveItem {
	const dir: Dir = {
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		parent: "parent-0000-0000-0000-000000000000",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}

	return narrowItem(dir)
}

const items = [item("a"), item("b")]

function renderNav() {
	const onOpen = vi.fn()
	const virtualizer = { scrollToIndex: vi.fn() } as unknown as DriveVirtualizer["activeVirtualizer"]
	const itemRefs = { current: new Map<number, HTMLDivElement>() } as DriveVirtualizer["itemRefs"]
	const { result } = renderHook(() =>
		useDriveListboxNav({ items, viewMode: "list", columns: 1, virtualizer, itemRefs, variant: "drive", splat: "", onOpen })
	)

	return { result, onOpen }
}

function keyDown(key: string, listbox: HTMLElement, target: EventTarget): ReactKeyboardEvent<HTMLDivElement> {
	return {
		key,
		shiftKey: false,
		target,
		currentTarget: listbox,
		preventDefault: vi.fn()
	} as unknown as ReactKeyboardEvent<HTMLDivElement>
}

beforeEach(() => {
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
})

describe("useDriveListboxNav — key presses", () => {
	it("Enter inside the listbox opens the item under the cursor", () => {
		const { result, onOpen } = renderNav()
		const listbox = document.createElement("div")
		const row = listbox.appendChild(document.createElement("div"))

		act(() => {
			result.current.handleKeyDown(keyDown("Enter", listbox, row))
		})

		expect(onOpen).toHaveBeenCalledExactlyOnceWith(0)
	})

	// A row's ⋯ menu is portaled out of the listbox yet still bubbles through it in the React tree.
	it("ignores key presses from a portaled menu (Enter on a menu item opens nothing, Space selects nothing)", () => {
		const { result, onOpen } = renderNav()
		const listbox = document.createElement("div")
		const menuItem = document.body.appendChild(document.createElement("div"))

		act(() => {
			result.current.handleKeyDown(keyDown("Enter", listbox, menuItem))
			result.current.handleKeyDown(keyDown(" ", listbox, menuItem))
		})

		expect(onOpen).not.toHaveBeenCalled()
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	// The active row's ⋯ trigger is in the tab sequence and sits inside the listbox: Enter/Space on it
	// must reach the button, whose native click is what opens its menu.
	it("leaves Enter and Space on a row's ⋯ trigger to the button (no open, no toggle, no preventDefault)", () => {
		const { result, onOpen } = renderNav()
		const listbox = document.createElement("div")
		const row = listbox.appendChild(document.createElement("div"))
		const trigger = row.appendChild(document.createElement("button"))
		const preventDefault = vi.fn()

		act(() => {
			for (const key of ["Enter", " "]) {
				result.current.handleKeyDown({ ...keyDown(key, listbox, trigger), preventDefault })
			}
		})

		expect(onOpen).not.toHaveBeenCalled()
		expect(useDriveStore.getState().selectedItems).toEqual([])
		expect(preventDefault).not.toHaveBeenCalled()
	})
})
