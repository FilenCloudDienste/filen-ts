import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { CAPTURE_TIMESTAMP_FLOOR, captureTimestamp, sortPhotosByCaptureDesc, type PhotoItem } from "@/features/photos/lib/captureSort"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function photo(uuid: string, timestamp: bigint, created?: bigint, modified?: bigint): PhotoItem {
	const item = narrowItem({
		uuid: testUuid(uuid),
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

describe("CAPTURE_TIMESTAMP_FLOOR", () => {
	it("is exactly 1980-01-01 UTC (mobile lib/sort.ts's own constant)", () => {
		expect(CAPTURE_TIMESTAMP_FLOOR).toBe(Date.UTC(1980, 0, 1))
	})
})

describe("captureTimestamp", () => {
	const UPLOADED = 1_700_000_000_000n

	it("falls back to the upload timestamp when neither created nor modified is usable", () => {
		expect(captureTimestamp(photo("a", UPLOADED))).toBe(Number(UPLOADED))
	})

	it("prefers a qualifying created over the upload timestamp", () => {
		const created = 1_600_000_000_000n
		expect(captureTimestamp(photo("a", UPLOADED, created))).toBe(Number(created))
	})

	it("takes the MINIMUM of created and modified when both qualify", () => {
		const created = 1_600_000_000_000n
		const modified = 1_500_000_000_000n
		expect(captureTimestamp(photo("a", UPLOADED, created, modified))).toBe(Number(modified))
	})

	it("clamps out a candidate ABOVE the upload timestamp (a photo can't be modified before it was captured, but a bogus future client stamp is still garbage)", () => {
		const futureCreated = UPLOADED + 1_000n
		expect(captureTimestamp(photo("a", UPLOADED, futureCreated))).toBe(Number(UPLOADED))
	})

	it("clamps out a candidate exactly at the floor (floor is exclusive: value > FLOOR, not >=)", () => {
		const atFloor = BigInt(CAPTURE_TIMESTAMP_FLOOR)
		expect(captureTimestamp(photo("a", UPLOADED, atFloor))).toBe(Number(UPLOADED))
	})

	it("clamps out a candidate below the floor (legacy epoch-zero garbage)", () => {
		const belowFloor = 0n
		expect(captureTimestamp(photo("a", UPLOADED, belowFloor))).toBe(Number(UPLOADED))
	})

	it("accepts a candidate exactly one ms above the floor", () => {
		const justAboveFloor = BigInt(CAPTURE_TIMESTAMP_FLOOR) + 1n
		expect(captureTimestamp(photo("a", UPLOADED, justAboveFloor))).toBe(Number(justAboveFloor))
	})

	it("accepts a candidate exactly equal to the upload timestamp (<=, not <)", () => {
		expect(captureTimestamp(photo("a", UPLOADED, UPLOADED))).toBe(Number(UPLOADED))
	})

	it("modified alone (no created) qualifies exactly like created alone", () => {
		const modified = 1_600_000_000_000n
		expect(captureTimestamp(photo("a", UPLOADED, undefined, modified))).toBe(Number(modified))
	})

	it("a disqualified created still lets a qualifying modified win", () => {
		const disqualifiedCreated = UPLOADED + 1_000n // above uploaded, clamped out
		const qualifyingModified = 1_600_000_000_000n
		expect(captureTimestamp(photo("a", UPLOADED, disqualifiedCreated, qualifyingModified))).toBe(Number(qualifyingModified))
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
