// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { renderHook, cleanup } from "@testing-library/react"

vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))
vi.mock("@/lib/time", () => ({ intlLanguage: "en-US" }))

const { directorySizes } = vi.hoisted(() => ({
	directorySizes: {
		value: undefined as ReadonlyMap<string, number> | undefined,
		calls: [] as unknown[]
	}
}))

vi.mock("@/features/drive/hooks/useDriveDirectorySizes", () => ({
	useDriveDirectorySizes: (params: unknown) => {
		directorySizes.calls.push(params)

		return directorySizes.value
	}
}))

import { useSortedDriveItems } from "@/features/drive/hooks/useSortedDriveItems"
import { itemSorter, type SortByType } from "@/lib/sort"
import type { DriveItem } from "@/types"

function makeItem(type: string, name: string, uuid: string, size: bigint, timestamp: number): DriveItem {
	return {
		type,
		data: {
			uuid,
			size,
			timestamp,
			decryptedMeta: {
				name,
				mime: "application/octet-stream",
				modified: timestamp,
				created: timestamp
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

const items = [
	makeItem("file", "file10.txt", "f-10", 30n, 3),
	makeItem("directory", "b", "d-b", 0n, 1),
	makeItem("file", "file2.txt", "f-2", 10n, 5),
	makeItem("directory", "a", "d-a", 0n, 4),
	makeItem("file", "File1.txt", "f-1", 20n, 2)
]

beforeEach(() => {
	directorySizes.value = undefined
	directorySizes.calls = []
})

afterEach(() => {
	cleanup()
})

describe("useSortedDriveItems", () => {
	it.each(["nameAsc", "nameDesc", "sizeAsc", "sizeDesc", "lastModifiedAsc", "lastModifiedDesc"] satisfies SortByType[])(
		"returns exactly what the sorter returns for %s",
		sort => {
			directorySizes.value = new Map([
				["d-a", 5],
				["d-b", 50]
			])

			const { result } = renderHook(() => useSortedDriveItems({ items, drivePathType: "drive", sort, keepOrder: false }))

			expect(result.current).toEqual(itemSorter.sortItems(items, sort, { directorySizes: directorySizes.value }))
		}
	)

	it("keeps the given order and array when asked to", () => {
		const { result } = renderHook(() => useSortedDriveItems({ items, drivePathType: "drive", sort: "sizeDesc", keepOrder: true }))

		expect(result.current).toBe(items)
	})

	it("treats a missing listing as empty", () => {
		const { result } = renderHook(() => useSortedDriveItems({ items: undefined, drivePathType: "drive", sort: "nameAsc", keepOrder: false }))

		expect(result.current).toEqual([])
	})

	it("fetches directory sizes for the size sorts only, kept order included", () => {
		renderHook(() => useSortedDriveItems({ items, drivePathType: "trash", sort: "sizeAsc", keepOrder: true }))
		renderHook(() => useSortedDriveItems({ items, drivePathType: "trash", sort: "nameAsc", keepOrder: false }))

		expect(directorySizes.calls).toEqual([
			{ items, drivePathType: "trash", enabled: true },
			{ items, drivePathType: "trash", enabled: false }
		])
	})
})
