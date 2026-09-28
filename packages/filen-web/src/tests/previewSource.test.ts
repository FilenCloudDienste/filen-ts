import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	type PreviewSource,
	drivePreviewSources,
	previewSourceKey,
	previewSourceName,
	stepPreviewSourceIndex
} from "@/features/preview/lib/previewSource"

// Branded UuidStr fixture — see preview.logic.test.ts's own testUuid for why the cast is required.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function fileNamed(name: string, uuid: UuidStr = testUuid(name)): DriveItem {
	return narrowItem({
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	} satisfies File)
}

describe("drivePreviewSources", () => {
	it("wraps each drive item, preserving order and item identity", () => {
		const a = fileNamed("a.png")
		const b = fileNamed("b.mp4")
		const sources = drivePreviewSources([a, b])

		expect(sources).toHaveLength(2)
		expect(sources[0]).toEqual({ item: a })
		expect(sources[1]).toEqual({ item: b })
		// Same object reference, not a clone — a pure tag over the frozen snapshot.
		expect(sources[0]?.item).toBe(a)
	})

	it("is empty for an empty list", () => {
		expect(drivePreviewSources([])).toEqual([])
	})
})

describe("previewSourceKey", () => {
	it("keys a drive source by its item uuid", () => {
		const item = fileNamed("doc.pdf", testUuid("doc"))

		expect(previewSourceKey({ item })).toBe(item.data.uuid)
	})
})

describe("previewSourceName", () => {
	it("names a drive source by its decrypted name", () => {
		expect(previewSourceName({ item: fileNamed("photo.jpg") })).toBe("photo.jpg")
	})
})

describe("stepPreviewSourceIndex", () => {
	const sources: PreviewSource[] = [
		{ item: fileNamed("a.png", testUuid("a")) },
		{ item: fileNamed("b.mp4", testUuid("b")) },
		{ item: fileNamed("c.pdf", testUuid("c")) }
	]

	it("steps forward from the current key", () => {
		expect(stepPreviewSourceIndex(testUuid("a"), sources, 1)).toBe(1)
	})

	it("steps backward from the current key", () => {
		expect(stepPreviewSourceIndex(testUuid("c"), sources, -1)).toBe(1)
	})

	it("steps from a middle key", () => {
		expect(stepPreviewSourceIndex(testUuid("b"), sources, 1)).toBe(2)
	})

	it("clamps at the ends (no wrap)", () => {
		expect(stepPreviewSourceIndex(testUuid("a"), sources, -1)).toBe(0)
		expect(stepPreviewSourceIndex(testUuid("c"), sources, 1)).toBe(2)
	})

	it("steps from the start when the key is unresolvable", () => {
		expect(stepPreviewSourceIndex("missing", sources, 1)).toBe(1)
	})
})
