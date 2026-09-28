// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { Dir, SharedFile, UuidStr } from "@filen/sdk-rs"

// The thumbnail service reaches the Vite `?worker` client, unresolvable under vitest.
vi.mock("@/features/drive/lib/thumbnails", () => ({ setThumbnailViewport: vi.fn() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

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

describe("useDriveVirtualizer list keys", () => {
	it("gives each receiver's row of one shared item its own key", () => {
		const { result } = renderHook(() => useDriveVirtualizer([receiverRow(1), receiverRow(2)], "list"))
		const { getItemKey } = result.current.listVirtualizer.options

		expect(getItemKey(0)).not.toBe(getItemKey(1))
	})

	it("keys every other row by its uuid", () => {
		const item = directoryItem("a")
		const { result } = renderHook(() => useDriveVirtualizer([item], "list"))

		expect(result.current.listVirtualizer.options.getItemKey(0)).toBe(item.data.uuid)
	})
})
