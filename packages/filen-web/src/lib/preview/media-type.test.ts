import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import { allowedMediaContentType } from "@/lib/preview/media-type"

// Mirrors preview.logic.test.ts's own testUuid/mockFile/mockDir fixtures — each test file here owns
// its own local fixtures, no shared test-utils module.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
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
			data: { name: "clip.mp4", mime: "video/mp4", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function fileNamed(name: string, mime: string | undefined, options: { undecryptable?: boolean } = {}): DriveItem {
	const { undecryptable = false } = options

	return narrowItem(
		mockFile({
			uuid: testUuid(name),
			meta: undecryptable
				? { type: "encrypted", data: "ciphertext" }
				: { type: "decoded", data: { name, mime: mime ?? "", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 } }
		})
	)
}

function dirItem(): DriveItem {
	return narrowItem(mockDir())
}

describe("allowedMediaContentType", () => {
	it.each(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"])("%s passes for a video-category file", mime => {
		expect(allowedMediaContentType(fileNamed("clip.mp4", mime))).toBe(mime)
	})

	it.each(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac"])("%s passes for an audio-category file", mime => {
		expect(allowedMediaContentType(fileNamed("track.mp3", mime))).toBe(mime)
	})

	it.each([
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/svg+xml",
		"image/bmp",
		"image/x-icon",
		"image/apng",
		"image/avif"
	])("%s passes for an image-category file", mime => {
		expect(allowedMediaContentType(fileNamed("photo.jpg", mime))).toBe(mime)
	})

	it("rejects text/html even for a video-extension file (a spoofed/mismatched mime never passes)", () => {
		expect(allowedMediaContentType(fileNamed("clip.mp4", "text/html"))).toBeNull()
	})

	it("rejects an unlisted image mime", () => {
		expect(allowedMediaContentType(fileNamed("photo.jpg", "image/tiff"))).toBeNull()
	})

	it("rejects a whole-buffer category (pdf) regardless of mime", () => {
		expect(allowedMediaContentType(fileNamed("doc.pdf", "application/pdf"))).toBeNull()
	})

	it("rejects an empty-string mime on an otherwise video/audio/image-extension file", () => {
		expect(allowedMediaContentType(fileNamed("clip.mp4", undefined))).toBeNull()
		expect(allowedMediaContentType(fileNamed("photo.jpg", undefined))).toBeNull()
	})

	it("rejects an undecryptable file", () => {
		expect(allowedMediaContentType(fileNamed("clip.mp4", "video/mp4", { undecryptable: true }))).toBeNull()
	})

	// HEIC/HEIF resolve category "image" but must never stream — the one place this module's own
	// exclusion (not just an absent-from-allowlist mime) is load-bearing is a spoofed streamable mime.
	it("rejects a HEIC/HEIF file's own real mime", () => {
		expect(allowedMediaContentType(fileNamed("photo.heic", "image/heic"))).toBeNull()
		expect(allowedMediaContentType(fileNamed("photo.heif", "image/heif"))).toBeNull()
	})

	it("rejects a HEIC file even with a spoofed, otherwise-allowlisted mime", () => {
		expect(allowedMediaContentType(fileNamed("photo.heic", "image/jpeg"))).toBeNull()
	})

	it("rejects a directory", () => {
		expect(allowedMediaContentType(dirItem())).toBeNull()
	})

	it("is case-insensitive and trims the mime", () => {
		expect(allowedMediaContentType(fileNamed("clip.mp4", " VIDEO/MP4 "))).toBe("video/mp4")
	})
})
