import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	previewType,
	canPreview,
	needsImageTransform,
	previewableSiblings,
	stepPreviewIndex,
	streamFailureAction,
	extensionOf,
	codeMirrorLanguageFor,
	decodeUtf8,
	PREVIEW_MAX_BYTES
} from "@/features/drive/lib/preview.logic"

// Mirrors contactPickerDialog.logic.test.ts's own testUuid helper — UuidStr is a branded template
// literal type (`${string}-${string}-${string}-${string}`) a plain dynamic string can't satisfy
// structurally, so a labeled fixture uuid needs this one cast, same as every other test fixture here.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Local fixtures mirror bulkActionBar.test.ts's own per-file convention.
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

	// HEIC/HEIF join "image" too (they're previewable), but can't stream — needsImageTransform below
	// is the seam a viewer branches on to route them through the buffered + transform path instead.
	it.each(["heic", "heif"])("%s -> image", ext => {
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

	// An unknown extension with no mime hint lands here.
	it.each(["exe", "psd", "zip"])("%s -> other", ext => {
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

describe("needsImageTransform", () => {
	it.each(["heic", "heif"])("is true for a %s file", ext => {
		expect(needsImageTransform(fileNamed(`photo.${ext}`))).toBe(true)
	})

	it("is case-insensitive on the extension", () => {
		expect(needsImageTransform(fileNamed("PHOTO.HEIC"))).toBe(true)
	})

	it.each(["jpg", "png", "webp", "avif"])("is false for a streamable image extension (%s)", ext => {
		expect(needsImageTransform(fileNamed(`photo.${ext}`))).toBe(false)
	})

	it("is false for a non-image category", () => {
		expect(needsImageTransform(fileNamed("clip.mp4"))).toBe(false)
	})

	it("is false for a directory", () => {
		expect(needsImageTransform(dirItem())).toBe(false)
	})

	it("is false for an undecryptable file (no name to resolve an extension from)", () => {
		expect(needsImageTransform(fileNamed("photo.heic", { undecryptable: true }))).toBe(false)
	})

	// Extension-only, never the item's own mime — a spoofed streamable mime on a HEIC-named file must
	// still resolve true (mediaType.ts's own test file separately proves this keeps it off the SW route).
	it("ignores a spoofed streamable mime on a HEIC-named file", () => {
		expect(needsImageTransform(fileNamed("photo.heic", { mime: "image/jpeg" }))).toBe(true)
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

	// text/code/markdown are whole-buffer categories too (never in STREAMED_CATEGORIES) — same cap
	// applies, no category-specific override. A 256 MiB+1 log file must refuse preview rather than ever
	// reaching CodeMirror.
	it.each([
		["notes.txt", "text"],
		["script.ts", "code"],
		["readme.md", "markdown"]
	])("is false for a %s (%s) over the size cap", name => {
		expect(canPreview(fileNamed(name, { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(false)
	})

	it.each([
		["notes.txt", "text"],
		["script.ts", "code"],
		["readme.md", "markdown"]
	])("is true for a %s (%s) exactly at the size cap", name => {
		expect(canPreview(fileNamed(name, { size: PREVIEW_MAX_BYTES }), "drive")).toBe(true)
	})

	it("is true for a streamed category (video/audio/image) even past the whole-buffer size cap — uncapped", () => {
		expect(canPreview(fileNamed("movie.mp4", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(true)
		expect(canPreview(fileNamed("song.mp3", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(true)
		expect(canPreview(fileNamed("photo.jpg", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(true)
	})

	// HEIC/HEIF are category "image" (a STREAMED_CATEGORIES member) but never actually stream
	// (needsImageTransform) — canPreview must apply the whole-buffer cap to them like pdf/docx, not the
	// uncapped rule above.
	it("is false for a HEIC file over the size cap — buffered, not streamed, despite being 'image'", () => {
		expect(canPreview(fileNamed("photo.heic", { size: PREVIEW_MAX_BYTES + 1n }), "drive")).toBe(false)
	})

	it("is true for a HEIC file at or under the size cap", () => {
		expect(canPreview(fileNamed("photo.heic", { size: PREVIEW_MAX_BYTES }), "drive")).toBe(true)
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

describe("extensionOf", () => {
	it("returns the lowercased extension with no leading dot", () => {
		expect(extensionOf("report.PDF")).toBe("pdf")
	})

	it("returns the empty string for a dotfile (leading dot only)", () => {
		expect(extensionOf(".gitignore")).toBe("")
	})

	it("returns the empty string for a name with no extension", () => {
		expect(extensionOf("README")).toBe("")
	})

	it("uses the LAST dot for a multi-dot name", () => {
		expect(extensionOf("archive.tar.gz")).toBe("gz")
	})
})

describe("decodeUtf8", () => {
	it("decodes plain ASCII", () => {
		expect(decodeUtf8(new TextEncoder().encode("hello world"))).toBe("hello world")
	})

	it("decodes multi-byte UTF-8 (accents, CJK, emoji) round-trip", () => {
		const text = "café — 日本語 — 🎉"

		expect(decodeUtf8(new TextEncoder().encode(text))).toBe(text)
	})

	it("returns an empty string for an empty buffer", () => {
		expect(decodeUtf8(new Uint8Array(0))).toBe("")
	})

	// Non-fatal: an invalid byte sequence becomes the U+FFFD replacement character rather than
	// throwing — a preview always shows SOMETHING for a whole-buffer text/code/markdown file (mirrors
	// the app's mobile counterpart's own plain `new TextDecoder().decode(bytes)`, no `fatal: true`); a
	// labeled "can't display" would be wrong for a file that's mostly valid UTF-8 with a few bad bytes.
	it("never throws on an invalid byte sequence — decodes to the replacement character", () => {
		const invalid = new Uint8Array([0xff, 0xfe, 0x00, 0x41])

		expect(() => decodeUtf8(invalid)).not.toThrow()
		expect(decodeUtf8(invalid)).toContain("�")
	})
})

describe("codeMirrorLanguageFor — extension to CodeMirror language tag", () => {
	// The full code-extension set (previewType's own CODE_EXTENSIONS) mapped to the tag
	// textViewer.tsx's own loader switches on, or "" when no CodeMirror grammar is wired for it (still
	// a fully usable read-only plain-text view, just unhighlighted).
	const EXPECTED: Record<string, string> = {
		js: "javascript",
		cjs: "javascript",
		mjs: "javascript",
		jsx: "jsx",
		tsx: "tsx",
		ts: "typescript",
		cpp: "cpp",
		c: "cpp",
		php: "php",
		htm: "html",
		html5: "html",
		html: "html",
		css: "css",
		css3: "css",
		coffee: "coffeescript",
		litcoffee: "coffeescript",
		sass: "sass",
		xml: "xml",
		json: "json",
		sql: "sql",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		py3: "python",
		py: "python",
		cmake: "cmake",
		cs: "csharp",
		dart: "dart",
		dockerfile: "dockerfile",
		go: "go",
		less: "less",
		yaml: "yaml",
		vue: "",
		svelte: "",
		vbs: "vbscript",
		cobol: "cobol",
		toml: "toml",
		conf: "ini",
		ini: "ini",
		makefile: "",
		mk: "",
		gradle: "groovy",
		lua: "lua",
		h: "cpp",
		hpp: "cpp",
		rs: "rust",
		sh: "shell",
		rb: "ruby",
		ps1: "powershell",
		bat: "",
		ps: "",
		protobuf: "protobuf",
		proto: "protobuf"
	}

	it.each(Object.entries(EXPECTED))("%s -> %s", (ext, expected) => {
		expect(codeMirrorLanguageFor(ext)).toBe(expected)
	})

	// Markdown's own "view source" fallback (markdownViewer.tsx delegating to TextViewer) resolves a
	// language too, even though md/markdown never reach here via the "code" category.
	it.each(["md", "markdown"])("%s -> markdown (view-source fallback)", ext => {
		expect(codeMirrorLanguageFor(ext)).toBe("markdown")
	})

	it('returns "" for an unrecognized extension', () => {
		expect(codeMirrorLanguageFor("xyz123")).toBe("")
	})

	it('returns "" for the empty extension (no-extension / dotfile names)', () => {
		expect(codeMirrorLanguageFor("")).toBe("")
	})

	// The real call path (textViewer.tsx) always feeds it extensionOf(name)'s already-lowercased
	// output — proven end to end here, mirroring previewType's own case-insensitivity proof.
	it("is case-insensitive end to end through extensionOf", () => {
		expect(codeMirrorLanguageFor(extensionOf("SCRIPT.TS"))).toBe("typescript")
	})
})
