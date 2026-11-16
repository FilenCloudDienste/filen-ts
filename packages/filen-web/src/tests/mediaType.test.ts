import { describe, expect, it } from "vitest"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { EXTENSION_TIERS, RAW_IMAGE_EXTENSIONS, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
import { allowedMediaContentType, inlineTypeForExtension, isRescuable } from "@/features/preview/lib/mediaType"
import { AUDIO_FORMATS } from "@filen/shared"
import { IMAGE_FORMATS } from "@/features/preview/lib/imageFormat"
import { testUuid } from "@/tests/support/uuid"

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
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

	it("serves a video or image file stored without a type, or a generic binary one, as its extension says", () => {
		expect(allowedMediaContentType(fileNamed("clip.mp4", undefined))).toBe("video/mp4")
		expect(allowedMediaContentType(fileNamed("clip.mkv", "application/octet-stream"))).toBe("video/x-matroska")
		expect(allowedMediaContentType(fileNamed("photo.jpg", undefined))).toBe("image/jpeg")
		expect(allowedMediaContentType(fileNamed("photo.png", "application/octet-stream"))).toBe("image/png")
		expect(allowedMediaContentType(fileNamed("favicon.ico", "binary/octet-stream"))).toBe("image/x-icon")
		expect(allowedMediaContentType(fileNamed("photo.jfif", "application/octet-stream"))).toBe("image/jpeg")
		expect(allowedMediaContentType(fileNamed("photo.pjp", undefined))).toBe("image/jpeg")
	})

	it("serves an allowlisted stored type verbatim, never its canonical form", () => {
		expect(allowedMediaContentType(fileNamed("track.wav", "audio/x-wav"))).toBe("audio/x-wav")
		expect(allowedMediaContentType(fileNamed("photo.jfif", "image/jpeg"))).toBe("image/jpeg")
	})

	it("serves a stored alias the allowlist refuses as its canonical type", () => {
		expect(allowedMediaContentType(fileNamed("photo.jpg", "image/pjpeg"))).toBe("image/jpeg")
		expect(allowedMediaContentType(fileNamed("photo.pjpeg", "image/pjpeg"))).toBe("image/jpeg")
		expect(allowedMediaContentType(fileNamed("logo.png", "image/x-png"))).toBe("image/png")
		expect(allowedMediaContentType(fileNamed("favicon.ico", "image/vnd.microsoft.icon"))).toBe("image/x-icon")
	})

	it("never serves an SVG by a type it did not store", () => {
		expect(allowedMediaContentType(fileNamed("logo.svg", "image/svg+xml"))).toBe("image/svg+xml")
		expect(allowedMediaContentType(fileNamed("logo.svg", undefined))).toBeNull()
		expect(allowedMediaContentType(fileNamed("logo.svg", "application/octet-stream"))).toBeNull()
		expect(allowedMediaContentType(fileNamed("logo.svg", "image/x-png"))).toBeNull()
	})

	it("refuses a specific type that is neither allowlisted nor an alias of one", () => {
		expect(allowedMediaContentType(fileNamed("photo.jpg", "text/html"))).toBeNull()
		expect(allowedMediaContentType(fileNamed("photo.jpg", "application/x-shockwave-flash"))).toBeNull()
	})

	it("gives every natively shown image, and every video and audio extension, a type the allowlist serves, unless it is never rescued", () => {
		const media = EXTENSION_TIERS.flatMap(([extensions]) => [...extensions]).filter(extension => {
			const category = previewCategoryForExtension(extension)

			// An image the browser does not decode itself is never served inline.
			return category === "image" ? IMAGE_FORMATS.get(extension)?.decode === "native" : category === "video" || category === "audio"
		})

		expect(media).toContain("pjp")

		for (const extension of media) {
			const served = inlineTypeForExtension(extension)

			expect(served !== null || !isRescuable(extension), extension).toBe(true)
		}

		for (const decoded of ["mka", "ac3", "eac3", "ec3", "dts"]) {
			expect(isRescuable(decoded), decoded).toBe(false)
			expect(allowedMediaContentType(fileNamed(`track.${decoded}`, "application/octet-stream"))).toBeNull()
		}

		for (const markup of ["svg", "svgz", "eps"]) {
			expect(isRescuable(markup), markup).toBe(false)
		}
	})

	it("serves an audio file stored without a type, or a generic binary one, as its extension says", () => {
		expect(allowedMediaContentType(fileNamed("track.mp3", undefined))).toBe("audio/mpeg")
		expect(allowedMediaContentType(fileNamed("track.mp3", "application/octet-stream"))).toBe("audio/mpeg")
		expect(allowedMediaContentType(fileNamed("book.m4b", "application/octet-stream"))).toBe("audio/mp4")
		// Ambiguous extensions (audio or video by content) settled as audio by their usual meaning.
		expect(allowedMediaContentType(fileNamed("song.m4a", undefined))).toBe("audio/mp4")
		expect(allowedMediaContentType(fileNamed("song.m4a", "application/octet-stream"))).toBe("audio/mp4")
		expect(allowedMediaContentType(fileNamed("song.ogg", undefined))).toBe("audio/ogg")
		expect(allowedMediaContentType(fileNamed("song.oga", "application/octet-stream"))).toBe("audio/ogg")
		expect(allowedMediaContentType(fileNamed("song.weba", "binary/octet-stream"))).toBe("audio/webm")
		// A specific type still decides, and only extensions the browser may play as they are get one.
		expect(allowedMediaContentType(fileNamed("track.mp3", "text/html"))).toBeNull()
		expect(allowedMediaContentType(fileNamed("film.mka", "application/octet-stream"))).toBeNull()
		expect(allowedMediaContentType(fileNamed("clip.mp4", "application/octet-stream"))).toBe("video/mp4")
	})

	it("serves every audio format stored with a generic type exactly as the hand-written map did", () => {
		const served = new Map([
			["mp3", "audio/mpeg"],
			["m4a", "audio/mp4"],
			["m4b", "audio/mp4"],
			["aac", "audio/aac"],
			["wav", "audio/wav"],
			["ogg", "audio/ogg"],
			["oga", "audio/ogg"],
			["opus", "audio/ogg"],
			["weba", "audio/webm"],
			["flac", "audio/flac"],
			["aiff", "audio/aiff"],
			["aif", "audio/aiff"],
			["caf", "audio/x-caf"]
		])

		for (const extension of AUDIO_FORMATS.keys()) {
			expect(allowedMediaContentType(fileNamed(`track.${extension}`, "application/octet-stream"))).toBe(served.get(extension) ?? null)
		}
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
		expect(allowedMediaContentType(fileNamed("DSCF0001.HIF", "image/jpeg"))).toBeNull()
	})

	// Camera RAW resolves its own "rawImage" category, which this module's allowlist-of-three excludes
	// outright — no browser decodes a RAW container, so serving one inline would hand the page bytes
	// nothing can render. Pinned per-family because a camera's real RAW mime starts with "image/" and
	// would otherwise look streamable to anything reading mime alone.
	it.each([...RAW_IMAGE_EXTENSIONS])("rejects a camera RAW file (%s), even with an image/* mime", ext => {
		expect(allowedMediaContentType(fileNamed(`shot.${ext}`, "image/jpeg"))).toBeNull()
		expect(allowedMediaContentType(fileNamed(`shot.${ext}`, `image/x-raw-${ext}`))).toBeNull()
	})

	it("rejects a directory", () => {
		expect(allowedMediaContentType(dirItem())).toBeNull()
	})

	it("is case-insensitive and trims the mime", () => {
		expect(allowedMediaContentType(fileNamed("clip.mp4", " VIDEO/MP4 "))).toBe("video/mp4")
	})
})

describe("inlineTypeForExtension", () => {
	it("serves an extension's canonical type only where the allowlist takes it", () => {
		expect(inlineTypeForExtension("jpeg")).toBe("image/jpeg")
		expect(inlineTypeForExtension("ico")).toBe("image/x-icon")
		expect(inlineTypeForExtension("svg")).toBe("image/svg+xml")
		expect(inlineTypeForExtension("heic")).toBeNull()
		expect(inlineTypeForExtension("tiff")).toBeNull()
		expect(inlineTypeForExtension("pdf")).toBeNull()
		expect(inlineTypeForExtension("html")).toBeNull()
		expect(inlineTypeForExtension("unknown")).toBeNull()
	})
})
