import { describe, expect, it } from "vitest"
import type { Dir, File, SharedDir, SharedFile, SharedRootDir, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { thumbnailCategory, pickEvictions, THUMB_SIZE_GATE, type ThumbCacheEntry } from "@/features/drive/lib/thumbnails.logic"

// Mirrors item.test.ts's own fixture helpers — this file needs the same six-arm coverage to prove
// thumbnailCategory routes the "file" arm only.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
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
			data: { name: "photo.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
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

function mockSharedRootDir(overrides: Partial<SharedRootDir> = {}): SharedRootDir {
	return {
		inner: {
			uuid: testUuid("sroot"),
			color: "default",
			timestamp: 1_700_000_000_000n,
			meta: { type: "decoded", data: { name: "SharedRoot" } }
		},
		sharingRole: { Sharer: { email: "sharer@filen.io", id: 42 } },
		writeAccess: true,
		...overrides
	}
}

function mockSharedDir(overrides: Partial<SharedDir> = {}): SharedDir {
	return {
		inner: mockDir({ uuid: testUuid("sdir"), meta: { type: "decoded", data: { name: "SharedChild" } } }),
		sharedTag: true,
		...overrides
	}
}

function mockSharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
	return {
		uuid: testUuid("sfile"),
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: { Receiver: { email: "receiver@filen.io", id: 7 } },
		sharedTag: true,
		...overrides
	}
}

// One-stop builder for the routing matrix below — mirrors preview.logic.test.ts's own fileNamed.
function fileNamed(name: string, options: { canMakeThumbnail?: boolean; size?: bigint; undecryptable?: boolean } = {}): DriveItem {
	const { canMakeThumbnail = true, size = 1_024n, undecryptable = false } = options

	return narrowItem(
		mockFile({
			canMakeThumbnail,
			size,
			meta: undecryptable
				? { type: "encrypted", data: "ciphertext" }
				: {
						type: "decoded",
						data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size, key: "key", version: 2 }
					}
		})
	)
}

describe("thumbnailCategory", () => {
	// The client-side createImageBitmap decode owns the format list now, not the SDK's wasm decoder —
	// bmp and avif join the raster set the browser can decode.
	it.each(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"])("%s -> image when under the size gate", ext => {
		expect(thumbnailCategory(fileNamed(`photo.${ext}`))).toBe("image")
	})

	// canMakeThumbnail is an SDK-decodability flag; the JS decode path no longer consults it, so a
	// decodable extension routes to "image" regardless of the flag's value.
	it("routes to image even when canMakeThumbnail is false — the flag no longer gates the JS decode", () => {
		expect(thumbnailCategory(fileNamed("photo.jpg", { canMakeThumbnail: false }))).toBe("image")
	})

	// svg is deliberately excluded (sanitization posture — never fed to a decoder), unlike every other
	// raster extension above.
	it("svg -> none — excluded on purpose, never decoded", () => {
		expect(thumbnailCategory(fileNamed("vector.svg"))).toBe("none")
	})

	it("is case-insensitive on the extension", () => {
		expect(thumbnailCategory(fileNamed("PHOTO.JPG"))).toBe("image")
	})

	it.each(["heic", "heif"])("%s -> heic when under the size gate", ext => {
		expect(thumbnailCategory(fileNamed(`photo.${ext}`))).toBe("heic")
	})

	it.each(["mp4", "mov", "webm", "m4v", "mkv"])("%s -> video, unconditionally (size-gate exempt)", ext => {
		expect(thumbnailCategory(fileNamed(`clip.${ext}`, { size: THUMB_SIZE_GATE + 1n }))).toBe("video")
	})

	it("pdf -> pdf when under the size gate", () => {
		expect(thumbnailCategory(fileNamed("doc.pdf"))).toBe("pdf")
	})

	it.each(["exe", "zip", "txt", "psd"])("%s -> none — unrecognized extension", ext => {
		expect(thumbnailCategory(fileNamed(`file.${ext}`))).toBe("none")
	})

	it("a dotfile with no real extension resolves none", () => {
		expect(thumbnailCategory(fileNamed(".gitignore"))).toBe("none")
	})

	describe("whole-buffer size gate (image, heic, pdf)", () => {
		it("is image exactly at the size gate", () => {
			expect(thumbnailCategory(fileNamed("photo.jpg", { size: THUMB_SIZE_GATE }))).toBe("image")
		})

		it("is none one byte over the size gate", () => {
			expect(thumbnailCategory(fileNamed("photo.jpg", { size: THUMB_SIZE_GATE + 1n }))).toBe("none")
		})

		it("is heic exactly at the size gate", () => {
			expect(thumbnailCategory(fileNamed("photo.heic", { size: THUMB_SIZE_GATE }))).toBe("heic")
		})

		it("is none one byte over the size gate for heic", () => {
			expect(thumbnailCategory(fileNamed("photo.heic", { size: THUMB_SIZE_GATE + 1n }))).toBe("none")
		})

		it("is pdf exactly at the size gate", () => {
			expect(thumbnailCategory(fileNamed("doc.pdf", { size: THUMB_SIZE_GATE }))).toBe("pdf")
		})

		it("is none one byte over the size gate for pdf", () => {
			expect(thumbnailCategory(fileNamed("doc.pdf", { size: THUMB_SIZE_GATE + 1n }))).toBe("none")
		})
	})

	describe("undecryptable — no name to route on", () => {
		it("resolves none regardless of extension-bearing history", () => {
			expect(thumbnailCategory(fileNamed("photo.jpg", { undecryptable: true }))).toBe("none")
		})
	})

	describe("non-file arms — always none", () => {
		it("a directory", () => {
			expect(thumbnailCategory(narrowItem(mockDir()))).toBe("none")
		})

		it("a sharedRootDirectory", () => {
			expect(thumbnailCategory(narrowItem(mockSharedRootDir()))).toBe("none")
		})

		it("a nested sharedDirectory", () => {
			expect(thumbnailCategory(narrowItem({ ...mockSharedDir(), sharingRole: { Sharer: { email: "a@filen.io", id: 1 } } }))).toBe(
				"none"
			)
		})

		it("a sharedRootFile — structurally file-like but out of scope", () => {
			expect(thumbnailCategory(narrowItem(mockSharedFile()))).toBe("none")
		})

		it("a nested sharedFile — structurally file-like but out of scope", () => {
			const item = narrowItem({
				...mockFile({ uuid: testUuid("nested") }),
				sharingRole: { Receiver: { email: "b@filen.io", id: 2 } }
			})
			expect(thumbnailCategory(item)).toBe("none")
		})
	})
})

describe("pickEvictions", () => {
	function entry(name: string, size: number, lastModified: number): ThumbCacheEntry {
		return { name, size, lastModified }
	}

	it("is a no-op when already under the cap", () => {
		const entries = [entry("a", 10, 1), entry("b", 10, 2)]
		expect(pickEvictions(entries, 100)).toEqual([])
	})

	it("is a no-op when landing exactly on the cap", () => {
		const entries = [entry("a", 50, 1), entry("b", 50, 2)]
		expect(pickEvictions(entries, 100)).toEqual([])
	})

	it("evicts the single oldest entry when one byte over the cap", () => {
		const entries = [entry("old", 10, 1), entry("new", 10, 2)]
		expect(pickEvictions(entries, 19)).toEqual(["old"])
	})

	it("evicts oldest-first until back at or under the cap, stopping exactly at the boundary", () => {
		const entries = [entry("oldest", 10, 1), entry("middle", 10, 2), entry("newest", 10, 3)]
		// total 30, cap 15 -> evict oldest (remaining 20), evict middle (remaining 10 <= 15) -> stop
		expect(pickEvictions(entries, 15)).toEqual(["oldest", "middle"])
	})

	it("evicts everything when the cap is zero", () => {
		const entries = [entry("a", 10, 1), entry("b", 10, 2)]
		expect(pickEvictions(entries, 0)).toEqual(["a", "b"])
	})

	it("is a no-op on an empty entry list", () => {
		expect(pickEvictions([], 0)).toEqual([])
	})

	it("does not mutate the input array", () => {
		const entries = [entry("newest", 10, 2), entry("oldest", 10, 1)]
		pickEvictions(entries, 5)
		expect(entries).toEqual([entry("newest", 10, 2), entry("oldest", 10, 1)])
	})

	it("breaks lastModified ties by input order (stable sort)", () => {
		const entries = [entry("a", 10, 5), entry("b", 10, 5), entry("c", 10, 5)]
		expect(pickEvictions(entries, 15)).toEqual(["a", "b"])
	})
})
