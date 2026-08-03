// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"

// The DriveVirtualizer type below is only reachable through a module whose graph pulls in the Vite
// `?worker` client, unresolvable under vitest — mirrors itemMenu.test.ts's own mock boundary.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useDriveListboxNav } from "@/features/drive/hooks/useDriveListboxNav"
// Whole-statement `import type` (not the inline keyword — see lib/cache.ts): the inline form doesn't
// reliably elide here, and useDriveVirtualizer's own module graph reaches the Vite `?worker` client.
import type { DriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"

// The reveal effect is the most intricate piece of the "Open containing directory" flow: it has to
// fire AFTER the [variant, splat] navigation reset (which clears the selection in the same commit),
// exactly once, only for its own listing, and re-arm when the row lands late.

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

const SPLAT = "a/b"

// useDriveListboxNav takes its virtualizer and ref map as plain params, so both stub trivially. An
// empty ref map just lets the bounded rAF focus poll expire — the same path a not-yet-mounted row
// takes in production.
function renderNav(items: DriveItem[], splat = SPLAT) {
	const scrollToIndex = vi.fn()
	const virtualizer = { scrollToIndex } as unknown as DriveVirtualizer["activeVirtualizer"]
	const itemRefs = { current: new Map<number, HTMLDivElement>() } as DriveVirtualizer["itemRefs"]

	const rendered = renderHook(
		(props: { items: DriveItem[] }) =>
			useDriveListboxNav({
				items: props.items,
				viewMode: "list",
				columns: 1,
				virtualizer,
				itemRefs,
				variant: "drive",
				splat,
				onOpen: vi.fn()
			}),
		{ initialProps: { items } }
	)

	return { ...rendered, scrollToIndex }
}

beforeEach(() => {
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
})

describe("useDriveListboxNav — pending reveal", () => {
	it("reveals on mount: selects the requested row, moves the cursor to it and scrolls it into view", () => {
		const items = [item("a"), item("b"), item("c")]
		useDriveStore.setState({ pendingReveal: { uuid: items[1]?.data.uuid ?? "", splat: SPLAT } })

		const { result, scrollToIndex } = renderNav(items)

		// The navigation reset clears the selection in the same commit — a reveal effect declared
		// before it would leave the selection empty.
		expect(useDriveStore.getState().selectedItems.map(i => i.data.uuid)).toEqual([items[1]?.data.uuid])
		expect(result.current.safeActiveIndex).toBe(1)
		expect(scrollToIndex).toHaveBeenCalledWith(1, { align: "auto" })
	})

	it("consumes the request exactly once — a later re-render neither re-selects nor scrolls again", () => {
		const items = [item("a"), item("b")]
		useDriveStore.setState({ pendingReveal: { uuid: items[1]?.data.uuid ?? "", splat: SPLAT } })

		const { rerender, scrollToIndex } = renderNav(items)

		expect(useDriveStore.getState().pendingReveal).toBeNull()

		const callsAfterReveal = scrollToIndex.mock.calls.length
		useDriveStore.getState().clearSelectedItems()
		rerender({ items })

		expect(scrollToIndex.mock.calls.length).toBe(callsAfterReveal)
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("ignores — and drops — a request whose splat is not this listing's", () => {
		const items = [item("a"), item("b")]
		useDriveStore.setState({ pendingReveal: { uuid: items[1]?.data.uuid ?? "", splat: "somewhere/else" } })

		const { result, scrollToIndex } = renderNav(items)

		expect(useDriveStore.getState().selectedItems).toEqual([])
		expect(useDriveStore.getState().pendingReveal).toBeNull()
		expect(result.current.safeActiveIndex).toBe(0)
		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("re-arms when the item lands later — the virtualized/late-fetch case", () => {
		const target = item("late")
		useDriveStore.setState({ pendingReveal: { uuid: target.data.uuid, splat: SPLAT } })

		const { result, rerender, scrollToIndex } = renderNav([])

		expect(useDriveStore.getState().pendingReveal).not.toBeNull()
		expect(scrollToIndex).not.toHaveBeenCalled()

		rerender({ items: [item("a"), target] })

		expect(useDriveStore.getState().selectedItems.map(i => i.data.uuid)).toEqual([target.data.uuid])
		expect(result.current.safeActiveIndex).toBe(1)
		expect(scrollToIndex).toHaveBeenCalledWith(1, { align: "auto" })
	})
})
