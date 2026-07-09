import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import {
	previewType,
	canPreview,
	previewableSiblings,
	stepPreviewIndex,
	streamFailureAction,
	PREVIEW_MAX_BYTES
} from "@/lib/drive/preview.logic"

// Mirrors contact-picker-dialog.logic.test.ts's own testUuid helper — UuidStr is a branded template
// literal type (`${string}-${string}-${string}-${string}`) a plain dynamic string can't satisfy
// structurally, so a labeled fixture uuid needs this one cast, same as every other test fixture here.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Local fixtures mirror bulk-action-bar.test.ts's own per-file convention.
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
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
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

// One-stop builder for the previewType/canPreview matrix below — name drives the uuid too (unique per
// distinct name, stable across re-reads within one test) so pager tests can look items up by uuid
// without a separate counter.
function fileNamed(name: string, options: { mime?: string; size?: bigint; undecryptable?: boolean; uuid?: UuidStr } = {}): DriveItem {
	const { mime = "application/octet-stream", size = 1_024n, undecryptable = false, uuid = testUuid(name) } = options

	return narrowItem(
		mockFile({
			uuid,
			size,
			meta: undecryptable
				? { type: "encrypted", data: "ciphertext" }
				: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size, key: "key", version: 2 } }
		})
	)
}

function dirItem(overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir(overrides))
}

describe("previewType — extension category map", () => {
	it.each(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "apng", "avif"])("%s -> image", ext => {
		expect(previewType(fileNamed(`photo.${ext}`))).toBe("image")
	})

	it.each(["mp4", "webm", "mkv", "mov", "m4v"])("%s -> video", ext => {
		expect(previewType(fileNamed(`clip.${ext}`))).toBe("video")
	})

	it.each(["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"])("%s -> audio", ext => {
		expect(previewType(fileNamed(`track.${ext}`))).toBe("audio")
	})

	it("pdf -> pdf", () => {
		expect(previewType(fileNamed("doc.pdf"))).toBe("pdf")
	})

	it("docx -> docx", () => {
		expect(previewType(fileNamed("doc.docx"))).toBe("docx")
	})

	it.each(["md", "markdown"])("%s -> markdown", ext => {
		expect(previewType(fileNamed(`notes.${ext}`))).toBe("markdown")
	})

	it.each(["txt", "log"])("%s -> text", ext => {
		expect(previewType(fileNamed(`notes.${ext}`))).toBe("text")
	})

	// Mirrors filen-mobile's previewType.ts code-extension set in full (minus md/log, split into their
	// own categories above).
	it.each([
		"js",
		"cjs",
		"mjs",
		"jsx",
		"tsx",
		"ts",
		"cpp",
		"c",
		"php",
		"htm",
		"html5",
		"html",
		"css",
		"css3",
		"coffee",
		"litcoffee",
		"sass",
		"xml",
		"json",
		"sql",
		"java",
		"kt",
		"swift",
		"py3",
		"py",
		"cmake",
		"cs",
		"dart",
		"dockerfile",
		"go",
		"less",
		"yaml",
		"vue",
		"svelte",
		"vbs",
		"cobol",
		"toml",
		"conf",
		"ini",
		"makefile",
		"mk",
		"gradle",
		"lua",
		"h",
		"hpp",
		"rs",
		"sh",
		"rb",
		"ps1",
		"bat",
		"ps",
		"protobuf",
		"proto"
	])("%s -> code", ext => {
		expect(previewType(fileNamed(`source.${ext}`))).toBe("code")
	})

	// HEIC/HEIF deliberately excluded from "image" (no native browser decode); an unknown extension
	// with no mime hint also lands here.
	it.each(["heic", "heif", "exe", "psd", "zip"])("%s -> other", ext => {
		expect(previewType(fileNamed(`file.${ext}`))).toBe("other")
	})

	it("is case-insensitive on the extension", () => {
		expect(previewType(fileNamed("PHOTO.JPG"))).toBe("image")
	})

	it("a dotfile with no real extension (leading dot only) resolves via mime, else other", () => {
		expect(previewType(fileNamed(".gitignore"))).toBe("other")
	})

	it("falls back to mime when the extension is unrecognized", () => {
		expect(previewType(fileNamed("blob.bin", { mime: "image/png" }))).toBe("image")
		expect(previewType(fileNamed("blob2.bin", { mime: "video/mp4" }))).toBe("video")
		expect(previewType(fileNamed("blob3.bin", { mime: "audio/mpeg" }))).toBe("audio")
		expect(previewType(fileNamed("blob4.bin", { mime: "application/pdf" }))).toBe("pdf")
		expect(previewType(fileNamed("blob5.bin", { mime: "text/markdown" }))).toBe("markdown")
		expect(previewType(fileNamed("blob6.bin", { mime: "text/csv" }))).toBe("text")
	})

	it("extension always wins over a conflicting mime", () => {
		expect(previewType(fileNamed("photo.jpg", { mime: "application/pdf" }))).toBe("image")
	})

	it("an undecryptable item (null decryptedMeta) resolves other, never throws", () => {
		expect(previewType(fileNamed("photo.jpg", { undecryptable: true }))).toBe("other")
	})

	it("a directory resolves other", () => {
		expect(previewType(dirItem())).toBe("other")
	})
})

describe("canPreview", () => {
	it("is true for a decryptable, in-range file", () => {
		expect(canPreview(fileNamed("photo.jpg"), "drive")).toBe(true)
	})

	it("is false for a directory", () => {
		expect(canPreview(dirItem(), "drive")).toBe(false)
	})

	it("is false for an undecryptable file", () => {
		expect(canPreview(fileNamed("photo.jpg", { undecryptable: true }), "drive")).toBe(false)
	})

	it("is false for an 'other' category — no viewer exists, ever", () => {
		expect(canPreview(fileNamed("archive.zip"), "drive")).toBe(false)
	})

	it("is false for a whole-buffer-only category over the size cap", () => {
		expect(canPreview(fileNamed("doc.pdf", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(false)
	})

	it("is true for a whole-buffer-only category exactly at the size cap", () => {
		expect(canPreview(fileNamed("doc.pdf", { size: PREVIEW_MAX_BYTES }), "drive")).toBe(true)
	})

	it("is true for a streamed category (video/audio/image) even past the whole-buffer size cap — uncapped", () => {
		expect(canPreview(fileNamed("movie.mp4", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(true)
		expect(canPreview(fileNamed("song.mp3", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(true)
		expect(canPreview(fileNamed("photo.jpg", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(true)
	})

	it("does NOT exclude trash — a trashed file still previews, read-only, mirroring mobile", () => {
		expect(canPreview(fileNamed("photo.jpg"), "trash")).toBe(true)
	})

	it("does NOT exclude any other variant either — the base gate is variant-agnostic", () => {
		for (const variant of ["drive", "recents", "favorites", "trash", "sharedIn", "sharedOut"] as const) {
			expect(canPreview(fileNamed("photo.jpg"), variant)).toBe(true)
		}
	})
})

describe("streamFailureAction", () => {
	it("is 'buffer' for an in-range item — safe to retry via the whole-buffer fallback", () => {
		expect(streamFailureAction(fileNamed("clip.mp4", { size: 1_024n }))).toBe("buffer")
	})

	it("is 'buffer' for an item exactly at the size cap", () => {
		expect(streamFailureAction(fileNamed("clip.mp4", { size: PREVIEW_MAX_BYTES }))).toBe("buffer")
	})

	it("is 'error' for an item over the size cap — retrying would re-download the whole oversize file", () => {
		expect(streamFailureAction(fileNamed("clip.mp4", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("error")
	})

	it("is 'buffer' for a directory — synthetic 0n size never exceeds the cap", () => {
		expect(streamFailureAction(dirItem())).toBe("buffer")
	})
})

describe("previewableSiblings", () => {
	it("filters to only previewable items, preserving order", () => {
		const a = fileNamed("a.jpg")
		const b = dirItem()
		const c = fileNamed("c.zip")
		const d = fileNamed("d.png")

		expect(previewableSiblings([a, b, c, d], "drive")).toEqual([a, d])
	})

	it("returns an empty array when nothing is previewable", () => {
		expect(previewableSiblings([dirItem(), fileNamed("a.zip")], "drive")).toEqual([])
	})

	it("returns every item when all are previewable", () => {
		const a = fileNamed("a.jpg")
		const b = fileNamed("b.png")

		expect(previewableSiblings([a, b], "drive")).toEqual([a, b])
	})
})

describe("stepPreviewIndex", () => {
	const a = fileNamed("a.jpg")
	const b = fileNamed("b.jpg")
	const c = fileNamed("c.jpg")
	const siblings = [a, b, c]

	it("steps forward by one", () => {
		expect(stepPreviewIndex(b.data.uuid, siblings, 1)).toBe(2)
	})

	it("steps backward by one", () => {
		expect(stepPreviewIndex(b.data.uuid, siblings, -1)).toBe(0)
	})

	it("clamps at the last index — no wrap", () => {
		expect(stepPreviewIndex(c.data.uuid, siblings, 1)).toBe(2)
	})

	it("clamps at the first index — no wrap", () => {
		expect(stepPreviewIndex(a.data.uuid, siblings, -1)).toBe(0)
	})

	it("falls back to index 0 for an unresolvable uuid, then steps from there", () => {
		expect(stepPreviewIndex("unknown-uuid", siblings, 1)).toBe(1)
		expect(stepPreviewIndex("unknown-uuid", siblings, -1)).toBe(0)
	})

	it("is a no-op index (0) on a single-item list either direction", () => {
		expect(stepPreviewIndex(a.data.uuid, [a], 1)).toBe(0)
		expect(stepPreviewIndex(a.data.uuid, [a], -1)).toBe(0)
	})
})
