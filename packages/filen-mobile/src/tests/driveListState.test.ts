import { vi, describe, it, expect } from "vitest"
import type { DriveItem } from "@/types"

// ---------------------------------------------------------------------------
// Mocks — must appear before the tested module is imported.
// utils.ts transitively pulls in @expo/vector-icons/Ionicons, @/lib/cache
// (→ @filen/sdk-rs wasm, needs `self`), and @/lib/decryption.
// ---------------------------------------------------------------------------

vi.mock("@expo/vector-icons/Ionicons", () => ({ default: {} }))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToName: new Map(),
		uuidToAnyDriveItem: new Map()
	}
}))

vi.mock("@/lib/decryption", () => ({
	driveItemDisplayName: (item: { data: { uuid: string } }) => item.data.uuid
}))

vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({}))

import { mergeByUuid } from "@/features/drive/utils"

// ---------------------------------------------------------------------------
// Minimal DriveItem factory — only the uuid discriminator is needed here
// ---------------------------------------------------------------------------

function item(uuid: string, name: string = uuid): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			undecryptable: false,
			decryptedMeta: { name }
		} as DriveItem["data"]
	} as DriveItem
}

// ---------------------------------------------------------------------------
// #27 — mergeByUuid: de-duplicate local listing + global search by uuid,
//        preferring the local listing copy for shared uuids.
// ---------------------------------------------------------------------------

describe("mergeByUuid", () => {
	it("returns local items unchanged when globalSearch is empty", () => {
		const a = item("a")
		const b = item("b")

		const result = mergeByUuid([a, b], [])

		expect(result).toEqual([a, b])
	})

	it("returns global items when local is empty", () => {
		const a = item("a")

		const result = mergeByUuid([], [a])

		expect(result).toEqual([a])
	})

	it("adds global items whose uuid is not in the local listing", () => {
		const local = item("a")
		const global = item("b")

		const result = mergeByUuid([local], [global])

		expect(result).toHaveLength(2)
		expect(result.map(i => i.data.uuid)).toEqual(["a", "b"])
	})

	it("does NOT add a global item whose uuid is already in the local listing", () => {
		const localCopy = item("a", "local-name")
		const globalCopy = item("a", "global-name")

		const result = mergeByUuid([localCopy], [globalCopy])

		expect(result).toHaveLength(1)
		// Local copy is kept (preferred)
		const first = result.at(0)
		expect((first?.data.decryptedMeta as { name: string } | undefined)?.name).toBe("local-name")
	})

	it("removes duplicate uuids that appear more than once in globalSearch", () => {
		const a = item("a")
		const a2 = item("a", "a-duplicate")

		const result = mergeByUuid([], [a, a2])

		// First occurrence wins (Map insertion order)
		expect(result).toHaveLength(1)
		expect(result.at(0)).toBe(a)
	})

	it("returns an empty array when both inputs are empty", () => {
		expect(mergeByUuid([], [])).toEqual([])
	})

	it("preserves local insertion order, then appends deduplicated global additions", () => {
		const a = item("a")
		const b = item("b")
		const c = item("c") // only in global
		const aDuplicate = item("a", "should-be-skipped")

		const result = mergeByUuid([a, b], [aDuplicate, c])

		expect(result.map(i => i.data.uuid)).toEqual(["a", "b", "c"])
	})

	it("local copy is used for a shared uuid, not the global copy", () => {
		const localA = item("shared-uuid", "authoritative-local")
		const globalA = item("shared-uuid", "stale-global")

		const result = mergeByUuid([localA], [globalA])

		expect(result).toHaveLength(1)
		expect(result.at(0)).toBe(localA)
	})

	it("does not mutate the input arrays", () => {
		const local = [item("a"), item("b")]
		const global = [item("b"), item("c")]

		const localBefore = [...local]
		const globalBefore = [...global]

		mergeByUuid(local, global)

		expect(local).toEqual(localBefore)
		expect(global).toEqual(globalBefore)
	})
})
