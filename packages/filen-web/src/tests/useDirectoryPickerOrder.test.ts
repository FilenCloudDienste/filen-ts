// @vitest-environment jsdom

// Every drive picker lists a directory in name order, directories first, whatever the drive is sorted by.
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { driveItemName } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

const { listing } = vi.hoisted(() => ({ listing: { data: [] as DriveItem[] } }))

vi.mock("@/features/drive/queries/drive", () => ({
	useDirectoryListingQuery: () => listing,
	useDirectoryNamesQuery: () => ({ data: undefined })
}))

const { useDirectoryPicker } = await import("@/features/drive/hooks/useDirectoryPicker")

function file(name: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "audio/mpeg", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

function dir(name: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

describe("useDirectoryPicker", () => {
	it("lists directories first, each group in natural name order", () => {
		listing.data = [file("track 10.mp3"), dir("Live"), file("Track 2.mp3"), dir("albums"), file("b.mp3")]

		const { result } = renderHook(() => useDirectoryPicker())

		expect(result.current.items.map(driveItemName)).toEqual(["albums", "Live", "b.mp3", "Track 2.mp3", "track 10.mp3"])
	})
})
