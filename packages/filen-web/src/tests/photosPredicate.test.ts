import { describe, expect, it } from "vitest"
import type { File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isPhotoCandidate, isPhotoItem } from "@/features/photos/lib/predicate"
import { testUuid } from "@/tests/support/uuid"
import { mockDir } from "@/tests/fixtures/sdk"

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
		expect(isPhotoItem(fileNamed("beach.heic"))).toBe(true)
		expect(isPhotoItem(fileNamed("DSCF0001.HIF"))).toBe(true)
		expect(isPhotoItem(fileNamed("render.qoi"))).toBe(true)
		expect(isPhotoItem(fileNamed("photo.jxl"))).toBe(true)
		expect(isPhotoItem(fileNamed("scan.tif"))).toBe(true)
		expect(isPhotoItem(fileNamed("scan.TIFF"))).toBe(true)
	})

	it("drops an image format that is no photo by its own row (a gzipped SVG)", () => {
		expect(isPhotoItem(fileNamed("logo.svgz"))).toBe(false)
		expect(isPhotoItem(fileNamed("logo.svg"))).toBe(true)
		expect(isPhotoItem(fileNamed("art.psd"))).toBe(false)
		expect(isPhotoItem(fileNamed("art.psb"))).toBe(false)
		expect(isPhotoItem(fileNamed("figure.eps"))).toBe(false)
	})

	// A camera RAW is a photo by any user's reckoning, and the grid tile is thumbnail-driven — the SDK
	// produces those for RAW (usually straight off the embedded preview), so the row renders normally
	// even though no full-size viewer exists yet.
	it("keeps a camera RAW file", () => {
		expect(isPhotoItem(fileNamed("shot.nef"))).toBe(true)
		expect(isPhotoItem(fileNamed("shot.CR3"))).toBe(true)
		expect(isPhotoItem(fileNamed("shot.dng"))).toBe(true)
	})

	it("keeps an MP4 or QuickTime video (mobile parity)", () => {
		expect(isPhotoItem(fileNamed("clip.mp4"))).toBe(true)
		expect(isPhotoItem(fileNamed("clip.mov"))).toBe(true)
	})

	it("keeps the mp4 and Matroska family videos, never Ogg video", () => {
		for (const name of ["a.3gp", "a.3g2", "a.qt", "a.mk3d"]) {
			expect(isPhotoItem(fileNamed(name))).toBe(true)
		}

		expect(isPhotoItem(fileNamed("a.ogv"))).toBe(false)
		expect(isPhotoItem(fileNamed("a.avi"))).toBe(false)
	})

	it("drops a non-media file (pdf, code, text, ...)", () => {
		expect(isPhotoItem(fileNamed("report.pdf"))).toBe(false)
		expect(isPhotoItem(fileNamed("index.ts"))).toBe(false)
		expect(isPhotoItem(fileNamed("notes.txt"))).toBe(false)
	})

	it("drops a directory regardless of name", () => {
		expect(isPhotoItem(narrowItem(mockDir({ meta: { type: "decoded", data: { name: "beach.jpg" } } })))).toBe(false)
	})

	// Documents the invariant photos/lib/itemActions.ts and bulkActions.ts rely on instead of gating:
	// a photos listing item can NEVER be undecryptable, so neither builder needs its own undecryptable
	// branch (unlike driveSelectionActions, which does).
	it("drops an undecryptable file even when its (unreadable) name would otherwise look like media", () => {
		const undecryptable = narrowItem(mockFile({ meta: { type: "encrypted", data: "ciphertext" } }))

		expect(isPhotoItem(undecryptable)).toBe(false)
	})

	it("drops an undecryptable directory", () => {
		const undecryptable = narrowItem(mockDir({ meta: { type: "encrypted", data: "ciphertext" } }))

		expect(isPhotoItem(undecryptable)).toBe(false)
	})

	it("drops an unrecognized extension (falls through previewType's mime lookup to 'other')", () => {
		expect(isPhotoItem(fileNamed("archive.zip"))).toBe(false)
	})
})

describe("isPhotoCandidate", () => {
	const big = { size: 40n * 1024n * 1024n }

	it("keeps photos and what a content verdict could still make one, without reading any verdict", () => {
		expect(isPhotoCandidate(fileNamed("beach.jpg"))).toBe(true)
		expect(isPhotoCandidate(fileNamed("clip.ts", big))).toBe(true)
		expect(isPhotoCandidate(fileNamed("index.ts"))).toBe(false)
		expect(isPhotoCandidate(fileNamed("lib.d.ts", big))).toBe(false)
		expect(isPhotoCandidate(fileNamed("notes.txt", big))).toBe(false)
		expect(isPhotoCandidate(fileNamed("camera.mts", big))).toBe(true)
	})

	it("keeps no audio: the audio extensions, and a container whose MIME type says audio", () => {
		const withMime = (name: string, mime: string) =>
			fileNamed(name, {
				meta: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size: 1n, key: "k", version: 2 } }
			})

		for (const name of ["song.m4a", "album.mka", "talk.weba", "voice.oga", "track.mp3"]) {
			expect(isPhotoCandidate(fileNamed(name))).toBe(false)
		}

		expect(isPhotoCandidate(withMime("voice.mp4", "audio/mp4"))).toBe(false)
		expect(isPhotoCandidate(withMime("talk.webm", "audio/webm"))).toBe(false)
		// audio/x-matroska resolves the .mka row, so an audio-signalled .mkv is audio, as album.mka is.
		expect(isPhotoCandidate(withMime("concert.mkv", "audio/x-matroska"))).toBe(false)
		expect(isPhotoCandidate(withMime("clip.mp4", "video/mp4"))).toBe(true)
	})

	it("shows a candidate by its verdict", () => {
		expect(isPhotoItem(fileNamed("clip.ts", big), "transportStream")).toBe(true)
		expect(isPhotoItem(fileNamed("clip.ts", big), "notTransportStream")).toBe(false)
		expect(isPhotoItem(fileNamed("talk.webm"), "audio")).toBe(false)
		expect(isPhotoItem(fileNamed("talk.webm"), null)).toBe(true)
	})
})
