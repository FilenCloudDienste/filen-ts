import { beforeEach, describe, expect, it } from "vitest"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { describeSelectionStoreContract } from "@/tests/contracts/selection"
import { receiverRow } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"

// Selection logic is item-type-agnostic (keyed only by data.uuid), so a directory fixture built
// through the real narrowItem is enough — no need for a file counterpart in this file.
function directoryItem(uuid: UuidStr): DriveItem {
	const dir: Dir = {
		uuid,
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: uuid } }
	}

	return narrowItem(dir)
}

beforeEach(() => {
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
})

describe("pending reveal", () => {
	it("round-trips a request and clears it again", () => {
		useDriveStore.getState().requestReveal({ uuid: testUuid("a"), splat: "a/b" })

		expect(useDriveStore.getState().pendingReveal).toEqual({ uuid: testUuid("a"), splat: "a/b" })

		useDriveStore.getState().clearPendingReveal()

		expect(useDriveStore.getState().pendingReveal).toBeNull()
	})

	it("a second request replaces the first — only the latest reveal can ever fire", () => {
		useDriveStore.getState().requestReveal({ uuid: testUuid("a"), splat: "a" })
		useDriveStore.getState().requestReveal({ uuid: testUuid("b"), splat: "b" })

		expect(useDriveStore.getState().pendingReveal).toEqual({ uuid: testUuid("b"), splat: "b" })
	})
})

describeSelectionStoreContract({
	makeItem: directoryItem,
	selected: () => useDriveStore.getState().selectedItems,
	seed: selectedItems => {
		useDriveStore.setState({ selectedItems })
	},
	toggle: item => {
		useDriveStore.getState().toggleSelectedItem(item)
	},
	set: next => {
		useDriveStore.getState().setSelectedItems(next)
	},
	remove: uuids => {
		useDriveStore.getState().removeFromSelection(uuids)
	},
	clear: () => {
		useDriveStore.getState().clearSelectedItems()
	}
})

describe("toggleSelectedItem", () => {
	it("adds and removes one receiver's row of a shared item without touching another receiver's", () => {
		const bob = receiverRow(1)
		const carol = receiverRow(2)

		useDriveStore.setState({ selectedItems: [bob] })
		useDriveStore.getState().toggleSelectedItem(carol)

		expect(useDriveStore.getState().selectedItems).toEqual([bob, carol])

		useDriveStore.getState().toggleSelectedItem(bob)

		expect(useDriveStore.getState().selectedItems).toEqual([carol])
	})
})

describe("removeFromSelection", () => {
	it("drops every receiver's row of a gone shared item", () => {
		const itemA = directoryItem(testUuid("a"))

		useDriveStore.setState({ selectedItems: [receiverRow(1), itemA, receiverRow(2)] })
		useDriveStore.getState().removeFromSelection([testUuid("shared")])

		expect(useDriveStore.getState().selectedItems).toEqual([itemA])
	})
})

describe("pruneSelection", () => {
	it("drops every selected row failing keep, by data.uuid", () => {
		const itemA = directoryItem(testUuid("a"))
		const itemB = directoryItem(testUuid("b"))

		useDriveStore.setState({ selectedItems: [receiverRow(1), itemA, receiverRow(2), itemB] })
		useDriveStore.getState().pruneSelection(item => item.data.uuid !== testUuid("shared") && item.data.uuid !== testUuid("b"))

		expect(useDriveStore.getState().selectedItems).toEqual([itemA])
	})

	it("emits no store update when every selected row is kept", () => {
		useDriveStore.setState({ selectedItems: [directoryItem(testUuid("a"))] })

		const prev = useDriveStore.getState()
		let notified = 0
		const unsubscribe = useDriveStore.subscribe(() => {
			notified++
		})

		useDriveStore.getState().pruneSelection(() => true)
		unsubscribe()

		expect(useDriveStore.getState()).toBe(prev)
		expect(notified).toBe(0)
	})
})

describe("removeRowsFromSelection", () => {
	it("drops only the given receiver's row, keeping the item's other receiver rows selected", () => {
		const itemA = directoryItem(testUuid("a"))
		const carol = receiverRow(2)

		useDriveStore.setState({ selectedItems: [receiverRow(1), itemA, carol] })
		useDriveStore.getState().removeRowsFromSelection([receiverRow(1)])

		expect(useDriveStore.getState().selectedItems).toEqual([itemA, carol])
	})

	it("is a no-op (same array reference) when none of the given rows are selected", () => {
		useDriveStore.setState({ selectedItems: [receiverRow(1)] })

		const prev = useDriveStore.getState().selectedItems

		useDriveStore.getState().removeRowsFromSelection([receiverRow(2)])
		useDriveStore.getState().removeRowsFromSelection([])

		expect(useDriveStore.getState().selectedItems).toBe(prev)
	})
})
