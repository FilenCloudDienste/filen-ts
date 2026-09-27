import { describe, expect, it } from "vitest"
import type { File, StableUuid, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isRevisionOf, settleHeldRevisions } from "@/features/preview/lib/remoteChange.logic"

function testUuid(label: string): UuidStr {
	return `${label.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-000000000000` as UuidStr
}

const LINEAGE: StableUuid = testUuid("lineage")

// null: listed without a lineage id (a default parameter would swallow an explicit undefined).
function file(label: string, stableUUID: StableUuid | null = LINEAGE): DriveItem {
	const data: File = {
		uuid: testUuid(label),
		stableUUID: stableUUID ?? undefined,
		parent: testUuid("parent"),
		size: 10n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "notes.md", mime: "text/markdown", modified: 1n, size: 10n, key: "k", version: 2 } }
	}

	return narrowItem(data)
}

// The rules themselves are covered in @filen/shared (remoteChange.test.ts); these pin the DriveItem mapping.
describe("isRevisionOf", () => {
	it("follows the file by its lineage, not its uuid", () => {
		expect(isRevisionOf(file("v1"), { item: file("v2") })).toBe(true)
		expect(isRevisionOf(file("v1"), { item: file("v2", testUuid("other")) })).toBe(false)
	})

	it("is not a revision when the slot already shows that uuid (its own save, or a repeat)", () => {
		expect(isRevisionOf(file("v2"), { item: file("v2") })).toBe(false)
	})

	it("falls back to the replaced uuid for a file listed without a lineage id", () => {
		expect(isRevisionOf(file("v1", null), { item: file("v2", null), previousUuid: testUuid("v1") })).toBe(true)
		expect(isRevisionOf(file("v1", null), { item: file("v2", null) })).toBe(false)
	})
})

describe("settleHeldRevisions", () => {
	it("finds the save's echo by the revision's item uuid", () => {
		const theirs = { item: file("theirs") }
		const echo = { item: file("mine") }

		expect(settleHeldRevisions([theirs, echo], testUuid("mine"))).toEqual({ replaced: true, newer: [] })
	})
})
