// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { Dir } from "@filen/sdk-rs"

// The thumbnail service reaches the Vite `?worker` client, unresolvable under vitest.
vi.mock("@/features/drive/lib/thumbnails", () => ({ setThumbnailViewport: vi.fn() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"
import { receiverRow } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"

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
