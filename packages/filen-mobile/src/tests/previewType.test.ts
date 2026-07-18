import { vi, describe, it, expect } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/constants", () => {
	const EXPO_IMAGE_SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".svg"])
	const EXPO_VIDEO_SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".3gp", ".webm", ".mkv"])
	const EXPO_AUDIO_SUPPORTED_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".mpga"])

	return {
		EXPO_IMAGE_SUPPORTED_EXTENSIONS,
		EXPO_VIDEO_SUPPORTED_EXTENSIONS,
		EXPO_AUDIO_SUPPORTED_EXTENSIONS
	}
})

import { getPreviewType, getPreviewTypeFromMime, isImagePreviewType, isProbablyBinaryText } from "@/lib/previewType"

// ---------------------------------------------------------------------------
// getPreviewType
// ---------------------------------------------------------------------------

describe("getPreviewType", () => {
	describe("image extensions", () => {
		it("returns 'image' for .jpg", () => {
			expect(getPreviewType("photo.jpg")).toBe("image")
		})

		it("returns 'image' for .jpeg", () => {
			expect(getPreviewType("photo.jpeg")).toBe("image")
		})

		it("returns 'image' for .png", () => {
			expect(getPreviewType("photo.png")).toBe("image")
		})

		it("returns 'image' for .webp", () => {
			expect(getPreviewType("photo.webp")).toBe("image")
		})

		it("normalises uppercase extension via trim+toLowerCase", () => {
			expect(getPreviewType("PHOTO.JPG")).toBe("image")
		})

		it("normalises whitespace-padded name", () => {
			expect(getPreviewType("  photo.png  ")).toBe("image")
		})
	})

	describe("svg", () => {
		// .svg must NOT classify as "image": on Android expo-image decodes SVG via androidsvg,
		// which can abort the process natively. It renders via react-native-svg (PreviewSvg) instead.
		it("returns 'svg' for .svg even though .svg is in the image-supported set", () => {
			expect(getPreviewType("logo.svg")).toBe("svg")
		})

		it("normalises uppercase .SVG", () => {
			expect(getPreviewType("LOGO.SVG")).toBe("svg")
		})
	})

	describe("video extensions", () => {
		it("returns 'video' for .mp4", () => {
			expect(getPreviewType("clip.mp4")).toBe("video")
		})

		it("returns 'video' for .mov", () => {
			expect(getPreviewType("clip.mov")).toBe("video")
		})

		it("returns 'video' for .mkv", () => {
			expect(getPreviewType("clip.mkv")).toBe("video")
		})
	})

	describe("audio extensions", () => {
		it("returns 'audio' for .mp3", () => {
			expect(getPreviewType("song.mp3")).toBe("audio")
		})

		it("returns 'audio' for .m4a", () => {
			expect(getPreviewType("song.m4a")).toBe("audio")
		})

		it("returns 'audio' for .flac", () => {
			expect(getPreviewType("song.flac")).toBe("audio")
		})
	})

	describe("pdf", () => {
		it("returns 'pdf' for .pdf", () => {
			expect(getPreviewType("document.pdf")).toBe("pdf")
		})
	})

	describe("text", () => {
		it("returns 'text' for .txt", () => {
			expect(getPreviewType("readme.txt")).toBe("text")
		})
	})

	describe("code extensions", () => {
		it("returns 'code' for .js", () => {
			expect(getPreviewType("app.js")).toBe("code")
		})

		it("returns 'code' for .ts", () => {
			expect(getPreviewType("app.ts")).toBe("code")
		})

		it("returns 'code' for .py", () => {
			expect(getPreviewType("script.py")).toBe("code")
		})

		it("returns 'code' for .rs", () => {
			expect(getPreviewType("main.rs")).toBe("code")
		})

		it("returns 'code' for .json", () => {
			expect(getPreviewType("config.json")).toBe("code")
		})

		it("returns 'code' for .yaml", () => {
			expect(getPreviewType("config.yaml")).toBe("code")
		})

		it("returns 'code' for .md", () => {
			expect(getPreviewType("README.md")).toBe("code")
		})

		it("returns 'code' for .html", () => {
			expect(getPreviewType("index.html")).toBe("code")
		})

		it("returns 'code' for .sh", () => {
			expect(getPreviewType("build.sh")).toBe("code")
		})

		it("returns 'code' for .toml", () => {
			expect(getPreviewType("Cargo.toml")).toBe("code")
		})
	})

	describe("docx", () => {
		it("returns 'docx' for .docx", () => {
			expect(getPreviewType("report.docx")).toBe("docx")
		})
	})

	describe("unknown / default branch", () => {
		it("returns 'unknown' for .zip", () => {
			expect(getPreviewType("archive.zip")).toBe("unknown")
		})

		it("returns 'unknown' for .bin", () => {
			expect(getPreviewType("file.bin")).toBe("unknown")
		})

		it("returns 'unknown' for a name with no extension", () => {
			expect(getPreviewType("noextension")).toBe("unknown")
		})

		it("returns 'unknown' for an empty string", () => {
			expect(getPreviewType("")).toBe("unknown")
		})
	})
})

// ---------------------------------------------------------------------------
// getPreviewTypeFromMime
// ---------------------------------------------------------------------------

describe("getPreviewTypeFromMime", () => {
	it("returns 'image' for image/jpeg", () => {
		// mime-types.extension('image/jpeg') -> 'jpeg' -> .jpeg -> image
		expect(getPreviewTypeFromMime("image/jpeg")).toBe("image")
	})

	it("returns 'image' for image/png", () => {
		expect(getPreviewTypeFromMime("image/png")).toBe("image")
	})

	it("returns 'svg' for image/svg+xml", () => {
		// mime-types.extension('image/svg+xml') -> 'svg' -> .svg -> svg (not image)
		expect(getPreviewTypeFromMime("image/svg+xml")).toBe("svg")
	})

	it("returns 'video' for video/mp4", () => {
		// mime-types.extension('video/mp4') -> 'mp4' -> .mp4 -> video
		expect(getPreviewTypeFromMime("video/mp4")).toBe("video")
	})

	it("returns 'audio' for audio/mpeg (maps to .mpga — must be in EXPO_AUDIO_SUPPORTED_EXTENSIONS)", () => {
		// mime-types resolves audio/mpeg -> 'mpga'; EXPO_AUDIO_SUPPORTED_EXTENSIONS mock includes .mpga
		expect(getPreviewTypeFromMime("audio/mpeg")).toBe("audio")
	})

	it("returns 'audio' for audio/mp3 (maps to .mp3)", () => {
		// mime-types resolves audio/mp3 -> 'mp3'
		expect(getPreviewTypeFromMime("audio/mp3")).toBe("audio")
	})

	it("returns 'pdf' for application/pdf", () => {
		// mime-types.extension('application/pdf') -> 'pdf' -> .pdf -> pdf
		expect(getPreviewTypeFromMime("application/pdf")).toBe("pdf")
	})

	it("returns 'text' for text/plain", () => {
		// mime-types.extension('text/plain') -> 'txt' -> .txt -> text
		expect(getPreviewTypeFromMime("text/plain")).toBe("text")
	})

	it("returns 'docx' for the Word MIME type", () => {
		// mime-types resolves the full OOXML mime -> 'docx'
		expect(getPreviewTypeFromMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx")
	})

	it("returns 'unknown' for an unrecognised MIME type (extension lookup returns false)", () => {
		// mime-types.extension('application/x-unknown') -> false -> 'unknown'
		expect(getPreviewTypeFromMime("application/x-unknown")).toBe("unknown")
	})

	it("returns 'unknown' for an empty string (extension lookup returns false)", () => {
		// mime-types.extension('') -> false -> 'unknown'
		expect(getPreviewTypeFromMime("")).toBe("unknown")
	})

	it("normalises uppercase MIME via toLowerCase before lookup", () => {
		// 'IMAGE/JPEG'.toLowerCase() -> 'image/jpeg' -> 'jpeg' -> .jpeg -> image
		expect(getPreviewTypeFromMime("IMAGE/JPEG")).toBe("image")
	})

	it("normalises whitespace-padded MIME via trim before lookup", () => {
		// '  image/jpeg  '.trim() -> 'image/jpeg' -> 'jpeg' -> .jpeg -> image
		expect(getPreviewTypeFromMime("  image/jpeg  ")).toBe("image")
	})

	it("normalises mixed-case with surrounding spaces", () => {
		expect(getPreviewTypeFromMime("  IMAGE/JPEG  ")).toBe("image")
	})
})

describe("isImagePreviewType", () => {
	it("is true for 'image'", () => {
		expect(isImagePreviewType("image")).toBe(true)
	})

	it("is true for 'svg' (image-equivalent for eligibility, only the renderer differs)", () => {
		expect(isImagePreviewType("svg")).toBe(true)
	})

	it("is false for non-image types", () => {
		expect(isImagePreviewType("video")).toBe(false)
		expect(isImagePreviewType("audio")).toBe(false)
		expect(isImagePreviewType("pdf")).toBe(false)
		expect(isImagePreviewType("text")).toBe(false)
		expect(isImagePreviewType("code")).toBe(false)
		expect(isImagePreviewType("docx")).toBe(false)
		expect(isImagePreviewType("unknown")).toBe(false)
	})
})

describe("isProbablyBinaryText", () => {
	it("flags content containing a NUL byte (AppleDouble sidecar magic)", () => {
		// AppleDouble files begin 0x00 0x05 0x16 0x07 — decoded, the NUL survives.
		expect(isProbablyBinaryText("\u0000\u0005\u0016\u0007rest-of-header")).toBe(true)
	})

	it("flags content dominated by replacement characters (undecodable bytes)", () => {
		expect(isProbablyBinaryText("\ufffd\ufffd\ufffd\ufffdab")).toBe(true)
	})

	it("tolerates a stray replacement character inside real text", () => {
		expect(isProbablyBinaryText(`before ${"\ufffd"} after — mostly legitimate text content`)).toBe(false)
	})

	it("accepts plain ASCII text", () => {
		expect(isProbablyBinaryText("hello world\nsecond line")).toBe(false)
	})

	it("accepts CJK text (the reported file name's characters)", () => {
		expect(isProbablyBinaryText("\u3010,\u3011, \u300e,\u300f")).toBe(false)
	})

	it("treats empty content as text", () => {
		expect(isProbablyBinaryText("")).toBe(false)
	})
})
