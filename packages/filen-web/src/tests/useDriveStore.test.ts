import { beforeEach, describe, expect, it } from "vitest"
import type { Dir, SharedFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — mirrors
// navigate.test.ts / queries/drive.test.ts's own uuid fixtures.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

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

describe("toggleSelectedItem", () => {
	it("adds an item that is not yet selected", () => {
		const item = directoryItem(testUuid("a"))

		useDriveStore.getState().toggleSelectedItem(item)

		expect(useDriveStore.getState().selectedItems).toEqual([item])
	})

	it("removes an already-selected item, matched by uuid", () => {
		const item = directoryItem(testUuid("a"))

		useDriveStore.setState({ selectedItems: [item] })
		useDriveStore.getState().toggleSelectedItem(item)

		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("toggling the same item twice restores the original selection", () => {
		const item = directoryItem(testUuid("a"))

		useDriveStore.getState().toggleSelectedItem(item)
		useDriveStore.getState().toggleSelectedItem(item)

		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("does not mutate the previous array (returns a new reference)", () => {
		const prev = useDriveStore.getState().selectedItems

		useDriveStore.getState().toggleSelectedItem(directoryItem(testUuid("a")))

		expect(useDriveStore.getState().selectedItems).not.toBe(prev)
	})

	it("only affects the matching uuid, leaving other selected items untouched", () => {
		const itemA = directoryItem(testUuid("a"))
		const itemB = directoryItem(testUuid("b"))

		useDriveStore.setState({ selectedItems: [itemA, itemB] })
		useDriveStore.getState().toggleSelectedItem(itemA)

		expect(useDriveStore.getState().selectedItems).toEqual([itemB])
	})

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

describe("setSelectedItems", () => {
	it("accepts a plain array and replaces the selection", () => {
		const item = directoryItem(testUuid("a"))

		useDriveStore.getState().setSelectedItems([item])

		expect(useDriveStore.getState().selectedItems).toEqual([item])
	})

	it("accepts an updater function that reads the previous selection", () => {
		const itemA = directoryItem(testUuid("a"))
		const itemB = directoryItem(testUuid("b"))

		useDriveStore.setState({ selectedItems: [itemA] })
		useDriveStore.getState().setSelectedItems(prev => [...prev, itemB])

		expect(useDriveStore.getState().selectedItems).toEqual([itemA, itemB])
	})
})

describe("removeFromSelection", () => {
	it("removes only the given uuids", () => {
		const itemA = directoryItem(testUuid("a"))
		const itemB = directoryItem(testUuid("b"))

		useDriveStore.setState({ selectedItems: [itemA, itemB] })
		useDriveStore.getState().removeFromSelection([testUuid("a")])

		expect(useDriveStore.getState().selectedItems).toEqual([itemB])
	})

	it("drops every receiver's row of a gone shared item", () => {
		const itemA = directoryItem(testUuid("a"))

		useDriveStore.setState({ selectedItems: [receiverRow(1), itemA, receiverRow(2)] })
		useDriveStore.getState().removeFromSelection([testUuid("shared")])

		expect(useDriveStore.getState().selectedItems).toEqual([itemA])
	})

	it("is a no-op (same array reference) when none of the given uuids are selected", () => {
		const itemA = directoryItem(testUuid("a"))

		useDriveStore.setState({ selectedItems: [itemA] })

		const prev = useDriveStore.getState().selectedItems

		useDriveStore.getState().removeFromSelection([testUuid("z")])

		expect(useDriveStore.getState().selectedItems).toBe(prev)
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

describe("clearSelectedItems", () => {
	it("empties a non-empty selection", () => {
		useDriveStore.setState({ selectedItems: [directoryItem(testUuid("a"))] })
		useDriveStore.getState().clearSelectedItems()

		expect(useDriveStore.getState().selectedItems).toEqual([])
	})
})
