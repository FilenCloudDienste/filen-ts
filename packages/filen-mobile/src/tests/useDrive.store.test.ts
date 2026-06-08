import { vi, describe, it, expect, beforeEach } from "vitest"

// useDrive.store only depends on zustand + the (type-only) DriveItem type and the
// pure toggleInArray helper from createSelectionSlice — no native modules. We still
// stub @filen/sdk-rs so the type-only import chain never tries to evaluate it.
vi.mock("@filen/sdk-rs", () => ({}))

import useDriveStore, { type DriveStore } from "@/features/drive/store/useDrive.store"
import type { DriveItem } from "@/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DriveItem-shaped object. The store identifies items by
 * `i.data.uuid` (see `driveItemId`), so only that field is load-bearing.
 */
function makeDriveItem(uuid: string): DriveItem {
	return {
		type: "file",
		data: { uuid }
	} as unknown as DriveItem
}

function resetDriveStore(): void {
	useDriveStore.setState({ selectedItems: [] } as Partial<DriveStore>)
}

// ---------------------------------------------------------------------------
// useDriveStore — removeFromSelection()
// ---------------------------------------------------------------------------

describe("useDriveStore.removeFromSelection", () => {
	beforeEach(() => {
		resetDriveStore()
	})

	it("removes a selected item by uuid while keeping the others", () => {
		useDriveStore.setState({ selectedItems: [makeDriveItem("a"), makeDriveItem("b"), makeDriveItem("c")] })

		useDriveStore.getState().removeFromSelection(["b"])

		const selected = useDriveStore.getState().selectedItems

		expect(selected.map(i => i.data.uuid)).toEqual(["a", "c"])
	})

	it("removes multiple uuids in a single call", () => {
		useDriveStore.setState({ selectedItems: [makeDriveItem("a"), makeDriveItem("b"), makeDriveItem("c")] })

		useDriveStore.getState().removeFromSelection(["a", "c"])

		const selected = useDriveStore.getState().selectedItems

		expect(selected.map(i => i.data.uuid)).toEqual(["b"])
	})

	it("is a no-op (same array reference) when the uuid is not selected", () => {
		const items = [makeDriveItem("a"), makeDriveItem("b")]
		useDriveStore.setState({ selectedItems: items })

		const before = useDriveStore.getState().selectedItems

		useDriveStore.getState().removeFromSelection(["not-selected"])

		const after = useDriveStore.getState().selectedItems

		// Same length AND same reference — no needless state update / re-render.
		expect(after).toBe(before)
		expect(after.map(i => i.data.uuid)).toEqual(["a", "b"])
	})

	it("is a no-op on an empty selection", () => {
		const before = useDriveStore.getState().selectedItems

		useDriveStore.getState().removeFromSelection(["anything"])

		const after = useDriveStore.getState().selectedItems

		expect(after).toBe(before)
		expect(after).toEqual([])
	})

	it("does not mutate the previous array (returns a new instance) when something is removed", () => {
		const items = [makeDriveItem("a"), makeDriveItem("b")]
		useDriveStore.setState({ selectedItems: items })

		useDriveStore.getState().removeFromSelection(["a"])

		// Original array reference must be untouched.
		expect(items.map(i => i.data.uuid)).toEqual(["a", "b"])
		expect(useDriveStore.getState().selectedItems).not.toBe(items)
	})

	it("removes all matching uuids, leaving an empty selection", () => {
		useDriveStore.setState({ selectedItems: [makeDriveItem("a"), makeDriveItem("b")] })

		useDriveStore.getState().removeFromSelection(["a", "b"])

		expect(useDriveStore.getState().selectedItems).toEqual([])
	})
})
