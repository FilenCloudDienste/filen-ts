import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isPhotoItem } from "@/features/photos/lib/predicate"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	}
}

function fileNamed(name: string, overrides: Partial<File> = {}): DriveItem {
	return narrowItem(
		mockFile({
			meta: {
				type: "decoded",
				data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1n, key: "k", version: 2 }
			},
			...overrides
		})
	)
}

describe("isPhotoItem", () => {
	it("keeps an image file", () => {
		expect(isPhotoItem(fileNamed("beach.jpg"))).toBe(true)
		expect(isPhotoItem(fileNamed("beach.png"))).toBe(true)
		expect(isPhotoItem(fileNamed("beach.webp"))).toBe(true)
	})

	it("keeps a video file unconditionally (mobile parity: videos pass with no extension gate)", () => {
		expect(isPhotoItem(fileNamed("clip.mp4"))).toBe(true)
		expect(isPhotoItem(fileNamed("clip.mov"))).toBe(true)
	})

	it("drops a non-media file (pdf, code, text, ...)", () => {
		expect(isPhotoItem(fileNamed("report.pdf"))).toBe(false)
		expect(isPhotoItem(fileNamed("index.ts"))).toBe(false)
		expect(isPhotoItem(fileNamed("notes.txt"))).toBe(false)
	})

	it("drops a directory regardless of name", () => {
		expect(isPhotoItem(narrowItem(mockDir({ meta: { type: "decoded", data: { name: "beach.jpg" } } })))).toBe(false)
	})

	it("drops an undecryptable file even when its (unreadable) name would otherwise look like media", () => {
		const undecryptable = narrowItem(mockFile({ meta: { type: "encrypted", data: "ciphertext" } }))

		expect(isPhotoItem(undecryptable)).toBe(false)
	})

	it("drops an undecryptable directory", () => {
		const undecryptable = narrowItem(mockDir({ meta: { type: "encrypted", data: "ciphertext" } }))

		expect(isPhotoItem(undecryptable)).toBe(false)
	})

	it("drops an unrecognized extension (falls through previewType's mime fallback to 'other')", () => {
		expect(isPhotoItem(fileNamed("archive.zip"))).toBe(false)
	})

	// Documents the invariant photos/lib/itemActions.ts and bulkActions.ts rely on instead of gating:
	// a photos listing item can NEVER be undecryptable, so neither builder needs its own undecryptable
	// branch (unlike driveItemActions/driveBulkActions, which both do).
	it("invariant: no undecryptable item ever passes, across every arm the predicate inspects", () => {
		const undecryptableFile = narrowItem(mockFile({ meta: { type: "encrypted", data: "ciphertext" } }))
		const undecryptableDir = narrowItem(mockDir({ meta: { type: "encrypted", data: "ciphertext" } }))

		for (const item of [undecryptableFile, undecryptableDir]) {
			expect(isPhotoItem(item)).toBe(false)
		}
	})
})
