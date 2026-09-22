import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { captureTimestamp, sortPhotosByCaptureDesc, type PhotoItem } from "@/features/photos/lib/captureSort"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function photo(uuid: string, timestamp: bigint, created?: bigint, modified?: bigint): PhotoItem {
	const item = narrowItem({
		uuid: testUuid(uuid),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: {
				name: "photo.jpg",
				mime: "image/jpeg",
				...(created !== undefined ? { created } : {}),
				modified: modified ?? timestamp,
				size: 1_024n,
				key: "k",
				version: 2
			}
		}
	} satisfies File)

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

// The pure floor/ceiling/min-of-candidates cases live in @filen/shared's estimateCaptureTimestamp
// tests. This just proves the wrapper unpacks data.timestamp/decryptedMeta.created/modified into it
// correctly.
describe("captureTimestamp", () => {
	it("unpacks data.timestamp and decryptedMeta.created/modified into the shared estimator", () => {
		const uploaded = 1_700_000_000_000n
		const created = 1_600_000_000_000n
		const modified = 1_500_000_000_000n

		expect(captureTimestamp(photo("a", uploaded, created, modified))).toBe(Number(modified))
	})
})

describe("sortPhotosByCaptureDesc", () => {
	it("sorts descending by capture timestamp", () => {
		const oldest = photo("old", 1_000n)
		const middle = photo("mid", 2_000n)
		const newest = photo("new", 3_000n)

		const sorted = sortPhotosByCaptureDesc([oldest, newest, middle])

		expect(sorted.map(item => item.data.uuid)).toEqual([newest.data.uuid, middle.data.uuid, oldest.data.uuid])
	})

	it("breaks a tie deterministically by uuid, regardless of input order", () => {
		const a = photo("aaaaaaaa", 5_000n)
		const b = photo("bbbbbbbb", 5_000n)

		expect(sortPhotosByCaptureDesc([b, a]).map(item => item.data.uuid)).toEqual([a.data.uuid, b.data.uuid])
		expect(sortPhotosByCaptureDesc([a, b]).map(item => item.data.uuid)).toEqual([a.data.uuid, b.data.uuid])
	})

	it("does not mutate the input array", () => {
		const items = [photo("a", 1_000n), photo("b", 2_000n)]
		const originalOrder = items.map(item => item.data.uuid)

		sortPhotosByCaptureDesc(items)

		expect(items.map(item => item.data.uuid)).toEqual(originalOrder)
	})

	it("an empty list sorts to an empty list", () => {
		expect(sortPhotosByCaptureDesc([])).toEqual([])
	})
})
