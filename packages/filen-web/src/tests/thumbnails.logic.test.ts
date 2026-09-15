import { describe, expect, it } from "vitest"
import type { Dir, File, SharedDir, SharedFile, SharedRootDir, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { RAW_IMAGE_EXTENSIONS } from "@/features/drive/lib/preview.logic"
import {
	thumbnailCategory,
	pickEvictions,
	THUMB_MAX_DIM,
	THUMB_SDK_MAX_HEIGHT,
	THUMB_SIZE_GATE,
	type ThumbCacheEntry
} from "@/features/drive/lib/thumbnails.logic"

// Mirrors item.test.ts's own fixture helpers — this file needs the same six-arm coverage to prove
// thumbnailCategory routes the "file" arm only.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		stableUUID: undefined,
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
		canMakeThumbnail: false,
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
	// The SDK owns every still image now — plain raster, HEIC and camera RAW alike — and its own
	// canMakeThumbnail flag is the only thing consulted. There is deliberately no extension allowlist
	// mirroring it here, so these cases prove the routing, not a format list.
	it.each(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif"])("%s -> sdk when canMakeThumbnail is true", ext => {
		expect(thumbnailCategory(fileNamed(`photo.${ext}`))).toBe("sdk")
	})

	it.each([...RAW_IMAGE_EXTENSIONS])("camera RAW %s -> sdk when canMakeThumbnail is true", ext => {
		expect(thumbnailCategory(fileNamed(`shot.${ext}`))).toBe("sdk")
	})

	// The inverse of what this file used to pin. The browser decode that ignored this flag is gone;
	// the SDK is the only producer for a still image, so its own "I cannot thumbnail this" is final.
	it("routes to none when canMakeThumbnail is false — the SDK's own answer is the gate", () => {
		expect(thumbnailCategory(fileNamed("photo.jpg", { canMakeThumbnail: false }))).toBe("none")
	})

	// No extension allowlist stands between the flag and the sdk arm: a format this app has never
	// heard of still thumbnails if the SDK says it can, which is exactly why the flag is the single
	// source of truth rather than a JS list that would drift from it.
	it("routes an unfamiliar extension to sdk purely on the flag", () => {
		expect(thumbnailCategory(fileNamed("mystery.qoi"))).toBe("sdk")
	})

	it("is case-insensitive on the extension", () => {
		expect(thumbnailCategory(fileNamed("PHOTO.JPG"))).toBe("sdk")
		expect(thumbnailCategory(fileNamed("SHOT.NEF"))).toBe("sdk")
	})

	// svg is refused even when the flag says otherwise — defense in depth on the long-standing
	// "never feed an untrusted svg to a decoder" posture (the wasm build has no SVG rasteriser
	// anyway, so this can only ever be belt-and-braces).
	it("svg -> none even with canMakeThumbnail true", () => {
		expect(thumbnailCategory(fileNamed("vector.svg"))).toBe("none")
		expect(thumbnailCategory(fileNamed("vector.svg", { canMakeThumbnail: false }))).toBe("none")
	})

	// Order guard: video and pdf both carry canMakeThumbnail false (Rust decodes neither), so they
	// have to be claimed by extension BEFORE the flag check or they would fall to "none" and lose the
	// client-side generators that do handle them.
	it.each(["mp4", "mov", "webm", "m4v", "mkv"])("%s -> video despite canMakeThumbnail false, and size-gate exempt", ext => {
		expect(thumbnailCategory(fileNamed(`clip.${ext}`, { canMakeThumbnail: false, size: THUMB_SIZE_GATE + 1n }))).toBe("video")
	})

	it("pdf -> pdf despite canMakeThumbnail false", () => {
		expect(thumbnailCategory(fileNamed("doc.pdf", { canMakeThumbnail: false }))).toBe("pdf")
	})

	it.each(["exe", "zip", "txt", "psd"])("%s -> none when the SDK cannot thumbnail it", ext => {
		expect(thumbnailCategory(fileNamed(`file.${ext}`, { canMakeThumbnail: false }))).toBe("none")
	})

	it("a dotfile with no real extension still routes on the flag alone", () => {
		expect(thumbnailCategory(fileNamed(".gitignore", { canMakeThumbnail: false }))).toBe("none")
		expect(thumbnailCategory(fileNamed(".gitignore"))).toBe("sdk")
	})

	// pdf is the ONE category left that buffers a whole file in JS memory, so it is the only one this
	// gate still applies to.
	describe("whole-buffer size gate (pdf only)", () => {
		it("is pdf exactly at the size gate", () => {
			expect(thumbnailCategory(fileNamed("doc.pdf", { canMakeThumbnail: false, size: THUMB_SIZE_GATE }))).toBe("pdf")
		})

		it("is none one byte over the size gate", () => {
			expect(thumbnailCategory(fileNamed("doc.pdf", { canMakeThumbnail: false, size: THUMB_SIZE_GATE + 1n }))).toBe("none")
		})
	})

	// The point of dropping the gate from the sdk arm: a 90 MB RAW is precisely the file whose camera
	// already embedded a full-size JPEG the SDK can lift out with a couple of range reads, and the SDK
	// enforces its own byte ceiling internally either way.
	describe("the sdk arm is NOT size-gated", () => {
		it("a large still image still routes to sdk", () => {
			expect(thumbnailCategory(fileNamed("photo.jpg", { size: THUMB_SIZE_GATE + 1n }))).toBe("sdk")
		})

		it("a 90 MB RAW still routes to sdk", () => {
			expect(thumbnailCategory(fileNamed("shot.nef", { size: 94_371_840n }))).toBe("sdk")
		})
	})

	describe("undecryptable — no metadata to route on", () => {
		it("resolves none regardless of extension-bearing history or the flag", () => {
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

describe("THUMB_SDK_MAX_HEIGHT", () => {
	// Pinned because the asymmetry is the whole point: the SDK accepts an embedded preview when
	// preview_long_side * 2 >= max(maxWidth, maxHeight), so a square 384 request would accept a 192px
	// EXIF stamp — mush in a tile twice that size. Doubling only the height raises that bar to 384px
	// without changing what the result is scaled to.
	it("is twice THUMB_MAX_DIM, never equal to it", () => {
		expect(THUMB_SDK_MAX_HEIGHT).toBe(THUMB_MAX_DIM * 2)
		expect(THUMB_SDK_MAX_HEIGHT).toBe(768)
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
