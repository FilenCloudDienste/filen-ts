import { vi, describe, it, expect } from "vitest"

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

import {
	getPreviewType,
	getDriveItemPreviewType,
	fileTypeExtension,
	extnameOf,
	isImagePreviewType,
	isProbablyBinaryText,
	SDK_RAW_PREVIEW_EXTENSIONS
} from "@/lib/previewType"
import type { DriveItemFileExtracted } from "@/types"
import { Paths } from "@/tests/mocks/expoFileSystem"

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

	describe("rawImage", () => {
		// RAW camera containers are previewed through the JPEG the SDK extracts (useRawPreviewQuery),
		// never decoded by expo-image, so they are their own type. The set has no Platform.select: it
		// is the same list on iOS and Android by construction.
		it("exports exactly the ten SDK preview families", () => {
			expect([...SDK_RAW_PREVIEW_EXTENSIONS].sort()).toEqual([
				".arw",
				".cr2",
				".cr3",
				".dng",
				".nef",
				".orf",
				".pef",
				".raf",
				".rw2",
				".srw"
			])
		})

		it.each([".cr2", ".cr3", ".nef", ".arw", ".dng", ".srw", ".pef", ".rw2", ".orf", ".raf"])("returns 'rawImage' for %s", ext => {
			expect(getPreviewType(`shot${ext}`)).toBe("rawImage")
		})

		it("normalises uppercase and whitespace-padded RAW names", () => {
			expect(getPreviewType("IMG_0001.CR2")).toBe("rawImage")
			expect(getPreviewType("  DSC_0001.NEF  ")).toBe("rawImage")
		})

		it("never wins over the expo-image set (image is checked first)", () => {
			expect(getPreviewType("photo.jpg")).toBe("image")
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

describe("isImagePreviewType", () => {
	it("is true for 'image'", () => {
		expect(isImagePreviewType("image")).toBe(true)
	})

	it("is true for 'svg' (image-equivalent for eligibility, only the renderer differs)", () => {
		expect(isImagePreviewType("svg")).toBe(true)
	})

	it("is true for 'rawImage' (previewed through the SDK-extracted JPEG)", () => {
		expect(isImagePreviewType("rawImage")).toBe(true)
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

// ---------------------------------------------------------------------------
// Name parse
//
// getPreviewType used to route every call through FileSystem.Paths.extname, which runs
// `new URL(name)` inside a try/catch — and on RN the global URL is Expo's pure-JS parser, so a
// bare filename ALWAYS threw. It now reads @filen/shared's effectiveExtension, a plain string parse:
// a file name is not a URL, colon or not (on device Paths.extname would drop everything after a '#').
// ---------------------------------------------------------------------------

describe("getPreviewType — name parse", () => {
	it("classifies ordinary names", () => {
		expect(getPreviewType("photo.jpg")).toBe("image")
		expect(getPreviewType("clip.MP4")).toBe("video")
		expect(getPreviewType("doc.pdf")).toBe("pdf")
		expect(getPreviewType("main.rs")).toBe("code")
		expect(getPreviewType("report.docx")).toBe("docx")
		expect(getPreviewType("logo.svg")).toBe("svg")
	})

	it("keeps the extname edge cases rather than a naive lastIndexOf('.')", () => {
		// A leading dot is not an extension, so a file literally named ".jpg" has NO extension and must
		// stay unknown; a trailing dot is not one either.
		expect(getPreviewType(".jpg")).toBe("unknown")
		expect(getPreviewType("archive.")).toBe("unknown")
		expect(getPreviewType("..")).toBe("unknown")
		expect(getPreviewType("no-extension")).toBe("unknown")
	})

	it("classifies colon-bearing names as plain names", () => {
		expect(getPreviewType("Chapter1: Draft #3.docx")).toBe("docx")
		expect(getPreviewType("12:30 meeting.pdf")).toBe("pdf")
	})

	it("never calls Paths.extname", () => {
		const extnameSpy = vi.spyOn(Paths, "extname")

		expect(getPreviewType("photo.jpg")).toBe("image")
		expect(getPreviewType("12:30 meeting.pdf")).toBe("pdf")
		expect(getPreviewType("LICENSE", "text/plain")).toBe("text")
		expect(extnameSpy).not.toHaveBeenCalled()

		extnameSpy.mockRestore()
	})

	it("treats surrounding whitespace and case the same as before", () => {
		expect(getPreviewType("  PHOTO.JPG  ")).toBe("image")
	})
})

describe("extnameOf", () => {
	it("routes ONLY colon-bearing names through Paths.extname", () => {
		const extnameSpy = vi.spyOn(Paths, "extname")

		expect(extnameOf("photo.jpg")).toBe(".jpg")
		expect(extnameSpy).not.toHaveBeenCalled()

		expect(extnameOf("12:30 meeting.pdf")).toBe(".pdf")
		expect(extnameSpy).toHaveBeenCalledWith("12:30 meeting.pdf")

		extnameSpy.mockRestore()
	})
})

// ---------------------------------------------------------------------------
// Type extension: own extension, then a well-known name, then the stored mime
// ---------------------------------------------------------------------------

describe("getPreviewType — well-known names", () => {
	it.each([
		["LICENSE", "text"],
		["licence", "text"],
		["README", "text"],
		[".gitignore", "text"],
		["Makefile", "code"],
		["GNUmakefile", "code"],
		["Dockerfile", "code"],
		[".bashrc", "code"],
		[".zshrc", "code"],
		[".env", "code"],
		[".env.local", "code"],
		["Gemfile", "code"],
		[".prettierrc", "code"]
	])("classifies %s as %s", (name, expected) => {
		expect(getPreviewType(name)).toBe(expected)
	})

	it("ignores a mime for a well-known name", () => {
		expect(getPreviewType("LICENSE", "application/octet-stream")).toBe("text")
		expect(getPreviewType("Makefile", "video/mp4")).toBe("code")
	})

	it("keeps a binary dotfile unknown", () => {
		expect(getPreviewType(".DS_Store")).toBe("unknown")
	})
})

describe("getPreviewType — stored mime", () => {
	it("classifies a file with no extension by its mime", () => {
		expect(getPreviewType("clip", "video/mp4")).toBe("video")
		expect(getPreviewType("scan", "application/pdf")).toBe("pdf")
		expect(getPreviewType("song", "audio/mpeg")).toBe("audio")
		expect(getPreviewType("photo", "image/jpeg")).toBe("image")
		expect(getPreviewType("vector", "image/svg+xml")).toBe("svg")
		expect(getPreviewType("notes", "text/plain; charset=utf-8")).toBe("text")
		expect(getPreviewType("data", "application/json")).toBe("code")
	})

	it("classifies a file with an unknown extension by its mime", () => {
		expect(getPreviewType("clip.bin", "video/mp4")).toBe("video")
		expect(getPreviewType("config.cfg", "text/plain")).toBe("text")
	})

	it("reads any other text/* mime as plain text", () => {
		expect(getPreviewType("page", "text/x-unheard-of")).toBe("text")
	})

	it("stays unknown for a mime the platform cannot preview", () => {
		// .avi is in neither mocked video set here, so its mime maps to nothing previewable.
		expect(getPreviewType("clip", "video/x-msvideo")).toBe("unknown")
		expect(getPreviewType("archive", "application/zip")).toBe("unknown")
		expect(getPreviewType("blob", "application/octet-stream")).toBe("unknown")
		// HEIF is not in the mocked image set: its mime maps to "heif", which this platform cannot show.
		expect(getPreviewType("photo", "image/heif")).toBe("unknown")
	})

	it("keeps a known extension over a contradicting mime", () => {
		expect(getPreviewType("photo.jpg", "video/mp4")).toBe("image")
		expect(getPreviewType("main.ts", "video/mp2t")).toBe("code")
		expect(getPreviewType("notes.txt", "application/pdf")).toBe("text")
		expect(getPreviewType("clip.mp4", "text/plain")).toBe("video")
	})

	it("classifies by name alone where the caller has no mime", () => {
		expect(getPreviewType("clip")).toBe("unknown")
		expect(getPreviewType("clip", null)).toBe("unknown")
		expect(getPreviewType("clip", undefined)).toBe("unknown")
		expect(getPreviewType("clip.mp4")).toBe("video")
	})
})

describe("fileTypeExtension", () => {
	it("returns the lowercase, dot-less extension the type is read from", () => {
		expect(fileTypeExtension("Photo.JPG")).toBe("jpg")
		expect(fileTypeExtension("Makefile")).toBe("makefile")
		expect(fileTypeExtension("LICENSE")).toBe("txt")
		expect(fileTypeExtension("clip", "video/mp4")).toBe("mp4")
		expect(fileTypeExtension("archive.zip", "application/zip")).toBe("zip")
		expect(fileTypeExtension("noextension")).toBe("")
	})
})

describe("getDriveItemPreviewType", () => {
	function fileItem(decryptedMeta: { name: string; mime: string } | null): DriveItemFileExtracted {
		return {
			type: "file",
			data: { uuid: "u1", decryptedMeta, undecryptable: decryptedMeta === null }
		} as unknown as DriveItemFileExtracted
	}

	it("reads the decrypted name and mime", () => {
		expect(getDriveItemPreviewType(fileItem({ name: "clip", mime: "video/mp4" }))).toBe("video")
		expect(getDriveItemPreviewType(fileItem({ name: "LICENSE", mime: "application/octet-stream" }))).toBe("text")
		expect(getDriveItemPreviewType(fileItem({ name: "photo.jpg", mime: "application/pdf" }))).toBe("image")
	})

	it("classifies an undecryptable file unknown", () => {
		expect(getDriveItemPreviewType(fileItem(null))).toBe("unknown")
	})
})

describe("isProbablyBinaryText — indexOf scan", () => {
	const FFFD = "\ufffd"

	it("returns false for clean text of any length", () => {
		expect(isProbablyBinaryText("hello world")).toBe(false)
		expect(isProbablyBinaryText("a".repeat(100_000))).toBe(false)
	})

	it("keeps the >10% threshold exclusive at exactly 10%", () => {
		// 10 replacements in 100 chars is exactly 0.1 — not greater than, so false.
		expect(isProbablyBinaryText(FFFD.repeat(10) + "a".repeat(90))).toBe(false)
		expect(isProbablyBinaryText(FFFD.repeat(11) + "a".repeat(89))).toBe(true)
	})

	it("early-exits on a dense prefix without changing the verdict", () => {
		expect(isProbablyBinaryText(FFFD.repeat(500) + "a".repeat(100))).toBe(true)
	})

	it("keeps the NUL short-circuit ahead of the scan", () => {
		expect(isProbablyBinaryText("a\u0000b")).toBe(true)
	})
})
