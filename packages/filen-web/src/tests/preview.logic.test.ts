import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	needsContentSniff,
	previewType,
	canPreview,
	canPreviewWith,
	needsImageTransform,
	isHeicName,
	pendingImageProbe,
	heldImageCap,
	canOpenAsText,
	fileTypeExtension,
	itemTypeExtension,
	isStreamedCategory,
	previewableSiblings,
	previewOpenTarget,
	stepPreviewIndex,
	streamFailureAction,
	extensionOf,
	codeMirrorLanguageFor,
	bufferedSizeCap,
	previewCategoryForExtension,
	linkAdmits,
	PREVIEW_MAX_BYTES,
	TEXT_MAX_BYTES,
	RAW_IMAGE_EXTENSIONS,
	CODE_EXTENSIONS
} from "@/features/drive/lib/preview.logic"
import { ARCHIVE_NAME_EXTENSIONS } from "@/features/drive/lib/archiveFormats"
import { recordFileKindVerdict } from "@/features/drive/lib/fileKindVerdicts"
import { isEditable } from "@/features/drive/lib/previewSave.logic"
import { TYPE_ROWS } from "@filen/shared"
import { testUuid } from "@/tests/support/uuid"
import { deviceProfile } from "@/lib/deviceProfile"

// Local fixtures mirror bulkActionBar.test.ts's own per-file convention.
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
	it.each([...RAW_IMAGE_EXTENSIONS])("camera RAW %s -> rawImage, its own category", ext => {
		expect(previewType(fileNamed(`shot.${ext}`))).toBe("rawImage")
	})

	// The RAW set has 21 families and none of them may collide with a browser-decodable extension —
	// "image" renders the full picture, "rawImage" only the camera's embedded preview, so an overlap
	// would silently demote a previewable file.
	it("has 21 RAW families, disjoint from the browser-decodable image set", () => {
		expect(RAW_IMAGE_EXTENSIONS.size).toBe(21)
		for (const ext of RAW_IMAGE_EXTENSIONS) {
			expect(previewType(fileNamed(`shot.${ext}`))).toBe("rawImage")
		}
	})

	it("is case-insensitive on a RAW extension", () => {
		expect(previewType(fileNamed("SHOT.NEF"))).toBe("rawImage")
	})

	// A camera's own RAW mime starts with "image/", so the mime fallback would call it "image" — the
	// extension map runs first and must win, or a RAW file would be handed to a browser decoder.
	it("a RAW extension beats a spoofed or genuine image/* mime", () => {
		expect(previewType(fileNamed("shot.cr3", { mime: "image/jpeg" }))).toBe("rawImage")
		expect(previewType(fileNamed("shot.arw", { mime: "image/x-sony-arw" }))).toBe("rawImage")
	})

	it.each(["jpg", "jpeg", "jfif", "jpe", "pjpeg", "pjp", "png", "gif", "webp", "svg", "bmp", "ico", "apng", "avif"])(
		"%s -> image",
		ext => {
			expect(previewType(fileNamed(`photo.${ext}`))).toBe("image")
		}
	)

	// HEIC/HEIF join "image" too (they're previewable), but can't stream — needsImageTransform below
	// is the seam a viewer branches on to route them through the buffered + transform path instead.
	// "hif" is Fujifilm's name for the same container.
	it.each(["heic", "heif", "hif"])("%s -> image", ext => {
		expect(previewType(fileNamed(`photo.${ext}`))).toBe("image")
	})

	it.each(["mp4", "webm", "mkv", "mov", "m4v", "m2ts"])("%s -> video", ext => {
		expect(previewType(fileNamed(`clip.${ext}`))).toBe("video")
	})

	// `.ts`/`.mts` are TypeScript until a probe reads one as a transport stream.
	it("keeps a .ts code, editable, until a probe says it is a transport stream", () => {
		const clip = fileNamed("clip.ts", { size: 4_000_000n })

		expect(previewType(clip)).toBe("code")
		expect(isEditable(clip, "drive")).toBe(true)
		expect(needsContentSniff(clip)).toBe("transportStream")

		recordFileKindVerdict(clip.data.uuid, "transportStream")

		expect(previewType(clip)).toBe("video")
		expect(isEditable(clip, "drive")).toBe(false)
		expect(needsContentSniff(clip)).toBeNull()
	})

	it("keeps a .ts the probe found to be TypeScript code, under the text cap", () => {
		const big = fileNamed("bundle.ts", { size: TEXT_MAX_BYTES + 1n })

		expect(canPreview(big)).toBe(true)

		recordFileKindVerdict(big.data.uuid, "notTransportStream")

		expect(previewType(big)).toBe("code")
		expect(canPreview(big)).toBe(false)
	})

	it("keeps TypeScript uploaded as video/mp2t editable code, and an audio-only .webm audio", () => {
		const source = fileNamed("server.ts", { mime: "video/mp2t", size: 40_000n })

		expect(previewType(source)).toBe("code")
		expect(isEditable(source, "drive")).toBe(true)
		expect(previewType(fileNamed("talk.webm", { mime: "audio/webm" }))).toBe("audio")
		expect(previewType(fileNamed("talk.webm", { mime: "video/webm" }))).toBe("video")
	})

	it("never asks about a small .ts or a declaration file", () => {
		expect(needsContentSniff(fileNamed("index.ts", { size: 4_000n }))).toBeNull()
		expect(needsContentSniff(fileNamed("lib.d.ts", { size: 4_000_000n }))).toBeNull()
		expect(needsContentSniff(fileNamed("clip.mts", { size: 4_000_000n }))).toBe("transportStream")
	})

	it("reads a transport stream's mime as video for a file without an extension", () => {
		expect(previewType(fileNamed("recording", { mime: "video/mp2t", size: 4_000n }))).toBe("video")
	})

	it.each(["mp3", "m4a", "m4b", "aac", "wav", "ogg", "flac", "opus", "mka", "ac3", "eac3", "ec3", "dts"])("%s -> audio", ext => {
		expect(previewType(fileNamed(`track.${ext}`))).toBe("audio")
	})

	it("reads an audiobook's type and a Matroska file of audio as audio", () => {
		expect(previewType(fileNamed("book", { mime: "audio/x-m4b" }))).toBe("audio")
		expect(previewType(fileNamed("concert.mkv", { mime: "audio/x-matroska" }))).toBe("audio")
		expect(previewType(fileNamed("concert.mkv", { mime: "video/x-matroska" }))).toBe("video")
	})

	it("pdf -> pdf", () => {
		expect(previewType(fileNamed("doc.pdf"))).toBe("pdf")
	})

	it("docx -> docx", () => {
		expect(previewType(fileNamed("doc.docx"))).toBe("docx")
	})

	it.each(["docm", "dotx", "dotm", "DOTM"])("%s -> docx (macro-enabled documents and templates)", ext => {
		expect(previewType(fileNamed(`letter.${ext}`))).toBe("docx")
	})

	it.each(["odt", "ott", "ODT"])("%s -> docx (OpenDocument text, translated)", ext => {
		expect(previewType(fileNamed(`letter.${ext}`))).toBe("docx")
	})

	it.each(["doc", "dot", "DOC"])("%s -> docx (Word 97–2003, from its conversion, view-only)", ext => {
		expect(previewType(fileNamed(`letter.${ext}`))).toBe("docx")
	})

	it.each(["rtf", "RTF"])("%s -> docx (RTF, read and written in its worker)", ext => {
		expect(previewType(fileNamed(`letter.${ext}`))).toBe("docx")
	})

	it("reads a .dot as a Word template until its content says it is text (a Graphviz graph)", () => {
		const graph = fileNamed("graph.dot", { mime: "application/msword" })

		expect(previewType(graph)).toBe("docx")
		expect(needsContentSniff(graph)).toBe("wordTemplate")

		recordFileKindVerdict(graph.data.uuid, "notWordBinary")

		expect(previewType(graph)).toBe("text")
		expect(needsContentSniff(graph)).toBeNull()
		// A text MIME type says so without a read.
		expect(previewType(fileNamed("flow.dot", { mime: "text/vnd.graphviz" }))).toBe("text")
	})

	it("reads a Word type by its MIME type only without a known extension (the extension first)", () => {
		expect(previewType(fileNamed("letter", { mime: "application/vnd.ms-word.template.macroEnabled.12" }))).toBe("docx")
		expect(previewType(fileNamed("macro", { mime: "application/vnd.ms-word.document.macroEnabled.12" }))).toBe("docx")
		expect(previewType(fileNamed("notes.txt", { mime: "application/vnd.ms-word.document.macroEnabled.12" }))).toBe("text")
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

	// An unknown extension with no mime hint lands here. rar and pkg have the archive icon but no reader.
	it.each(["exe", "rar", "pkg"])("%s -> other", ext => {
		expect(previewType(fileNamed(`file.${ext}`))).toBe("other")
	})

	it("is case-insensitive on the extension", () => {
		expect(previewType(fileNamed("PHOTO.JPG"))).toBe("image")
	})

	it("an unlisted dotfile with no real extension (leading dot only) resolves via mime, else other", () => {
		expect(previewType(fileNamed(".DS_Store"))).toBe("other")
		expect(previewType(fileNamed(".hgignore", { mime: "text/plain" }))).toBe("text")
	})

	it("a well-known extensionless name resolves like the extension it reads as", () => {
		expect(previewType(fileNamed("LICENSE"))).toBe("text")
		expect(previewType(fileNamed("README"))).toBe("text")
		expect(previewType(fileNamed(".gitignore"))).toBe("text")
		expect(previewType(fileNamed("Makefile"))).toBe("code")
		expect(previewType(fileNamed("Dockerfile"))).toBe("code")
		expect(previewType(fileNamed(".bashrc"))).toBe("code")
		expect(previewType(fileNamed(".env.local"))).toBe("code")
		expect(previewType(fileNamed("go.mod"))).toBe("text")
		expect(previewType(fileNamed("go.work"))).toBe("text")
		expect(previewType(fileNamed("tracker.mod"))).toBe("other")
	})

	it("a missing extension resolves by mime", () => {
		expect(previewType(fileNamed("clip", { mime: "video/mp4" }))).toBe("video")
		expect(previewType(fileNamed("scan", { mime: "application/pdf" }))).toBe("pdf")
		expect(previewType(fileNamed("table", { mime: "text/tab-separated-values" }))).toBe("spreadsheet")
	})

	// The mime reads through the shared mime table only: no coarse "any image/*" guess.
	it("an unlisted mime resolves other", () => {
		expect(previewType(fileNamed("blob.bin", { mime: "image/x-unknown" }))).toBe("other")
		expect(previewType(fileNamed("blob", { mime: "application/octet-stream" }))).toBe("other")
	})

	it("falls back to mime when the extension is unrecognized", () => {
		expect(previewType(fileNamed("blob.bin", { mime: "image/png" }))).toBe("image")
		expect(previewType(fileNamed("blob2.bin", { mime: "video/mp4" }))).toBe("video")
		expect(previewType(fileNamed("blob3.bin", { mime: "audio/mpeg" }))).toBe("audio")
		expect(previewType(fileNamed("blob4.bin", { mime: "application/pdf" }))).toBe("pdf")
		expect(previewType(fileNamed("blob5.bin", { mime: "text/markdown" }))).toBe("markdown")
		expect(previewType(fileNamed("blob6.bin", { mime: "text/csv" }))).toBe("spreadsheet")
		// Before the generic text/* arm, and the mime Excel registers for .csv on Windows too.
		expect(previewType(fileNamed("blob7.bin", { mime: "application/vnd.ms-excel" }))).toBe("spreadsheet")
	})

	it.each(["srt", "vtt", "ass", "ssa", "smi", "sami", "sub"])("%s -> subtitle", ext => {
		expect(previewType(fileNamed(`file.${ext}`))).toBe("subtitle")
	})

	it.each(["ics", "ifb", "ical"])("%s -> calendar", ext => {
		expect(previewType(fileNamed(`file.${ext}`))).toBe("calendar")
	})

	it.each(["vcf", "vcard"])("%s -> contact", ext => {
		expect(previewType(fileNamed(`file.${ext}`))).toBe("contact")
	})

	it.each(["eml"])("%s -> text", ext => {
		expect(previewType(fileNamed(`file.${ext}`))).toBe("text")
	})

	it("reads a mailbox as code (its grammar), geo files as maps, and notebook JSON as nothing yet", () => {
		expect(previewType(fileNamed("inbox.mbox"))).toBe("code")
		expect(previewType(fileNamed("tracks.gpx"))).toBe("geo")
		expect(previewType(fileNamed("map.geojson"))).toBe("geo")
		expect(previewType(fileNamed("analysis.ipynb"))).toBe("other")
	})

	it.each(["apk", "aab", "aar", "ipa", "jar", "war", "ear", "xpi", "crx", "whl", "nupkg", "vsix", "appx", "msix"])(
		"%s -> archive",
		ext => {
			expect(previewType(fileNamed(`file.${ext}`))).toBe("archive")
		}
	)

	it("reads an archive or package type as an archive without an extension", () => {
		for (const [mime, extension] of [
			["application/zip", "zip"],
			["application/x-zip-compressed", "zip"],
			["application/x-7z-compressed", "7z"],
			["application/x-tar", "tar"],
			["application/gzip", "gz"],
			["application/x-bzip2", "bz2"],
			["application/x-xz", "xz"],
			["application/zstd", "zst"],
			["application/java-archive", "jar"],
			["application/vnd.android.package-archive", "apk"],
			["application/x-xpinstall", "xpi"]
		] as const) {
			const item = fileNamed("download", { mime })

			expect(itemTypeExtension(item), mime).toBe(extension)
			expect(previewType(item), mime).toBe("archive")
		}
	})

	it("reads a subtitle, calendar, contact or message type by its type without an extension", () => {
		for (const [mime, extension] of [
			["text/vtt", "vtt"],
			["application/x-subrip", "srt"],
			["text/calendar", "ics"],
			["text/vcard", "vcf"],
			["text/x-vcard", "vcf"],
			["message/rfc822", "eml"],
			["application/mbox", "mbox"]
		] as const) {
			const item = fileNamed("download", { mime })

			expect(itemTypeExtension(item), mime).toBe(extension)
			const category: Record<string, string> = { mbox: "code", vtt: "subtitle", srt: "subtitle", ics: "calendar", vcf: "contact" }

			expect(previewType(item), mime).toBe(category[extension] ?? "text")
		}
	})

	it("recognises spreadsheets by extension", () => {
		for (const name of ["a.csv", "b.TSV", "c.xlsx", "d.xlsm", "e.xls"]) {
			expect(previewType(fileNamed(name))).toBe("spreadsheet")
		}
	})

	it("extension always wins over a conflicting mime", () => {
		expect(previewType(fileNamed("photo.jpg", { mime: "application/pdf" }))).toBe("image")
		expect(previewType(fileNamed("notes.txt", { mime: "video/mp4" }))).toBe("text")
	})

	it("an undecryptable item (null decryptedMeta) resolves other, never throws", () => {
		expect(previewType(fileNamed("photo.jpg", { undecryptable: true }))).toBe("other")
	})

	it("a directory resolves other", () => {
		expect(previewType(dirItem())).toBe("other")
	})
})

describe("archive category", () => {
	it.each([...ARCHIVE_NAME_EXTENSIONS])("%s -> archive", ext => {
		expect(previewType(fileNamed(`bundle.${ext}`))).toBe("archive")
	})

	// Code is listed after archives, so an extension in both would silently stop being code.
	it("shares no extension with the code set", () => {
		for (const ext of ARCHIVE_NAME_EXTENSIONS) {
			expect(CODE_EXTENSIONS.has(ext)).toBe(false)
		}
	})

	it("reads a compressed tarball by its last extension, case-insensitively", () => {
		expect(previewType(fileNamed("backup.tar.gz"))).toBe("archive")
		expect(previewType(fileNamed("PHOTOS.ZIP"))).toBe("archive")
	})

	// The archive never enters the JS heap: the worker lists it and the page holds only the entries.
	it("has no buffered size cap, so an archive of any size opens", () => {
		expect(bufferedSizeCap("archive", deviceProfile())).toBeNull()
		expect(canPreview(fileNamed("disk.tar", { size: 50n * 1024n ** 3n }))).toBe(true)
		expect(canPreview(fileNamed("bundle.zip", { undecryptable: true }))).toBe(false)
	})

	it("is not a streamed category", () => {
		expect(isStreamedCategory("archive")).toBe(false)
	})

	it("never offers Open as text, whatever the size", () => {
		expect(canOpenAsText(fileNamed("bundle.zip"))).toBe(false)
		expect(canOpenAsText(fileNamed("data.gz", { size: 1n }))).toBe(false)
	})
})

describe("HEIC routing helpers", () => {
	const native = { ...deviceProfile(), heicNative: "yes" as const }
	const unknown = { ...deviceProfile(), heicNative: "unknown" as const }

	it("names a HEIF by its extension whatever the browser decodes", () => {
		expect(isHeicName(fileNamed("photo.HEIC"))).toBe(true)
		expect(isHeicName(fileNamed("DSCF0001.hif"))).toBe(true)
		expect(isHeicName(fileNamed("photo.jpg"))).toBe(false)
		expect(needsImageTransform(fileNamed("photo.heic"), native)).toBe(false)
	})

	it("holds a HEIF's route on the HEIC probe only while it is unknown", () => {
		expect(pendingImageProbe(fileNamed("photo.heic"), unknown)).toBe("heic")
		expect(pendingImageProbe(fileNamed("photo.heic"), native)).toBeNull()
		expect(pendingImageProbe(fileNamed("photo.jpg"), unknown)).toBeNull()
		expect(pendingImageProbe(fileNamed("notes.txt"), unknown)).toBeNull()
	})

	it("caps a HEIF held whole at the image cap", () => {
		expect(heldImageCap(fileNamed("photo.heic"), native)).toBe(PREVIEW_MAX_BYTES)
	})
})

describe("needsImageTransform", () => {
	it.each(["heic", "heif", "hif"])("is true for a %s file", ext => {
		expect(needsImageTransform(fileNamed(`photo.${ext}`))).toBe(true)
	})

	it("is case-insensitive on the extension", () => {
		expect(needsImageTransform(fileNamed("PHOTO.HEIC"))).toBe(true)
		expect(needsImageTransform(fileNamed("DSCF0001.HIF"))).toBe(true)
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

	// The extension decides — a spoofed streamable mime on a HEIC-named file must still resolve true
	// (mediaType.ts's own test file separately proves this keeps it off the SW route).
	it("ignores a spoofed streamable mime on a HEIC-named file", () => {
		expect(needsImageTransform(fileNamed("photo.heic", { mime: "image/jpeg" }))).toBe(true)
	})

	it.each(["image/heic", "image/HEIF", " image/heic-sequence "])("routes an extensionless file with a %s mime to the transform", mime => {
		expect(needsImageTransform(fileNamed("IMG_0001", { mime }))).toBe(true)
	})

	// The mime only ever pulls a file OUT of the streamed branch: a recognized extension keeps its own answer.
	it("never lets a HEIC mime override a recognized extension", () => {
		expect(needsImageTransform(fileNamed("photo.jpg", { mime: "image/heic" }))).toBe(false)
	})

	it("is false for an extensionless file with a streamable image mime", () => {
		expect(needsImageTransform(fileNamed("IMG_0001", { mime: "image/jpeg" }))).toBe(false)
	})
})

describe("fileTypeExtension", () => {
	it("is the own extension when known, else the well-known name's, else the mime's, else the own one", () => {
		expect(fileTypeExtension("Photo.JPG", "video/mp4")).toBe("jpg")
		expect(fileTypeExtension("LICENSE", "application/octet-stream")).toBe("txt")
		expect(fileTypeExtension("clip", "video/mp4")).toBe("mp4")
		expect(fileTypeExtension("bundle.zip", "application/zip")).toBe("zip")
		expect(fileTypeExtension("mystery", undefined)).toBe("")
	})
})

describe("canOpenAsText", () => {
	it("holds for a decryptable file of an unknown type within the text cap", () => {
		expect(canOpenAsText(fileNamed("data.bin"))).toBe(true)
		expect(canOpenAsText(fileNamed("data.bin", { size: TEXT_MAX_BYTES }))).toBe(true)
	})

	it("never holds over the cap, for a known type, a directory or an undecryptable file", () => {
		expect(canOpenAsText(fileNamed("data.bin", { size: TEXT_MAX_BYTES + 1n }))).toBe(false)
		expect(canOpenAsText(fileNamed("notes.txt"))).toBe(false)
		expect(canOpenAsText(fileNamed("LICENSE"))).toBe(false)
		expect(canOpenAsText(dirItem())).toBe(false)
		expect(canOpenAsText(fileNamed("data.bin", { undecryptable: true }))).toBe(false)
	})
})

describe("isStreamedCategory", () => {
	it("is true only for image, video and audio", () => {
		expect(isStreamedCategory("image")).toBe(true)
		expect(isStreamedCategory("video")).toBe(true)
		expect(isStreamedCategory("audio")).toBe(true)

		for (const category of ["rawImage", "pdf", "docx", "spreadsheet", "text", "code", "markdown", "other"] as const) {
			expect(isStreamedCategory(category)).toBe(false)
		}
	})
})

describe("canPreview", () => {
	it("is true for a decryptable, in-range file", () => {
		expect(canPreview(fileNamed("photo.jpg"))).toBe(true)
	})

	it("is false for a directory", () => {
		expect(canPreview(dirItem())).toBe(false)
	})

	it("is false for an undecryptable file", () => {
		expect(canPreview(fileNamed("photo.jpg", { undecryptable: true }))).toBe(false)
	})

	it("is false for an 'other' category — no viewer exists, ever", () => {
		expect(canPreview(fileNamed("setup.exe"))).toBe(false)
	})

	it("is false for a whole-buffer-only category over the size cap", () => {
		expect(canPreview(fileNamed("report.docx", { size: PREVIEW_MAX_BYTES + 1n }))).toBe(false)
	})

	it("is true for a whole-buffer-only category exactly at the size cap", () => {
		expect(canPreview(fileNamed("report.docx", { size: PREVIEW_MAX_BYTES }))).toBe(true)
	})

	it("opens a PDF in ranges above the buffer cap, up to the device's ranged ceiling", () => {
		const GIB = 1024n * 1024n * 1024n
		const desktop = { ...deviceProfile(), mobile: false, pdfRangedMax: 8n * GIB }
		const phone = { ...deviceProfile(), mobile: true, pdfRangedMax: 2n * GIB }

		expect(canPreviewWith(fileNamed("doc.pdf", { size: PREVIEW_MAX_BYTES + 1n }), phone)).toBe(true)
		expect(canPreviewWith(fileNamed("doc.pdf", { size: 2n * GIB }), phone)).toBe(true)
		expect(canPreviewWith(fileNamed("doc.pdf", { size: 2n * GIB + 1n }), phone)).toBe(false)
		expect(canPreviewWith(fileNamed("doc.pdf", { size: 2n * GIB + 1n }), desktop)).toBe(true)
		expect(canPreviewWith(fileNamed("doc.pdf", { size: 8n * GIB }), desktop)).toBe(true)
		expect(canPreviewWith(fileNamed("doc.pdf", { size: 8n * GIB + 1n }), desktop)).toBe(false)
	})

	it("opens an e-book up to the device's cap: 256 MiB on a desktop, 64 MiB on a phone", () => {
		const MIB = 1024n * 1024n
		const desktop = { ...deviceProfile(), mobile: false }
		const phone = { ...deviceProfile(), mobile: true }

		for (const name of ["book.epub", "book.mobi", "book.fb2"]) {
			expect(previewCategoryForExtension(extensionOf(name))).toBe("ebook")
			expect(canPreviewWith(fileNamed(name, { size: 256n * MIB }), desktop)).toBe(true)
			expect(canPreviewWith(fileNamed(name, { size: 256n * MIB + 1n }), desktop)).toBe(false)
			expect(canPreviewWith(fileNamed(name, { size: 64n * MIB }), phone)).toBe(true)
			expect(canPreviewWith(fileNamed(name, { size: 64n * MIB + 1n }), phone)).toBe(false)
		}

		expect(bufferedSizeCap("ebook", phone)).toBe(64n * MIB)

		// A public link reads it in ranges, under the same cap.
		expect(linkAdmits("ebook", 64n * MIB, phone)).toBe(true)
		expect(linkAdmits("ebook", 64n * MIB + 1n, phone)).toBe(false)
		expect(linkAdmits("ebook", 256n * MIB + 1n, desktop)).toBe(false)
		// Kindle's own format stays a download.
		expect(previewCategoryForExtension("azw3")).toBeNull()
	})

	it("opens a deck at any size", () => {
		expect(canPreview(fileNamed("deck.pptx", { size: 50n * 1024n * 1024n * 1024n }))).toBe(true)
	})

	// text/code/markdown are whole-buffer categories with their own, lower cap: a 32 MiB+1 log file must
	// refuse preview rather than ever reaching CodeMirror.
	it.each([
		["notes.txt", "text"],
		["script.py", "code"],
		["readme.md", "markdown"]
	])("is false for a %s (%s) over the text size cap", name => {
		expect(canPreview(fileNamed(name, { size: TEXT_MAX_BYTES + 1n }))).toBe(false)
	})

	it.each([
		["notes.txt", "text"],
		["script.ts", "code"],
		["readme.md", "markdown"]
	])("is true for a %s (%s) exactly at the text size cap", name => {
		expect(canPreview(fileNamed(name, { size: TEXT_MAX_BYTES }))).toBe(true)
	})

	it("caps text below the other whole-buffer categories", () => {
		expect(bufferedSizeCap("text", deviceProfile())).toBe(TEXT_MAX_BYTES)
		expect(bufferedSizeCap("code", deviceProfile())).toBe(TEXT_MAX_BYTES)
		expect(bufferedSizeCap("markdown", deviceProfile())).toBe(TEXT_MAX_BYTES)
		expect(bufferedSizeCap("pdf", deviceProfile())).toBe(PREVIEW_MAX_BYTES)
	})

	it("is true for a streamed category (video/audio/image) even past the whole-buffer size cap — uncapped", () => {
		expect(canPreview(fileNamed("movie.mp4", { size: PREVIEW_MAX_BYTES + 1n }))).toBe(true)
		expect(canPreview(fileNamed("song.mp3", { size: PREVIEW_MAX_BYTES + 1n }))).toBe(true)
		expect(canPreview(fileNamed("photo.jpg", { size: PREVIEW_MAX_BYTES + 1n }))).toBe(true)
	})

	// HEIC/HEIF are category "image" (a streamed category) but do not stream without a native decoder
	// (needsImageTransform) — canPreview must apply the whole-buffer cap to them like pdf/docx, not the
	// uncapped rule above.
	it("is false for a HEIC file over the size cap — buffered, not streamed, despite being 'image'", () => {
		expect(canPreview(fileNamed("photo.heic", { size: PREVIEW_MAX_BYTES + 1n }))).toBe(false)
	})

	it("is true for a HEIC file at or under the size cap", () => {
		expect(canPreview(fileNamed("photo.heic", { size: PREVIEW_MAX_BYTES }))).toBe(true)
	})

	// rawImage is uncapped for the opposite reason to a streamed category: it is not streamed to the
	// page at all — the SDK reads whatever ranges it needs inside wasm, so the file never enters JS
	// memory and there is nothing for PREVIEW_MAX_BYTES to protect.
	it("is true for a RAW file far past the whole-buffer size cap — the bytes never enter JS memory", () => {
		expect(canPreview(fileNamed("shot.nef", { size: PREVIEW_MAX_BYTES * 4n }))).toBe(true)
	})

	it("is still false for an undecryptable RAW file", () => {
		expect(canPreview(fileNamed("shot.nef", { undecryptable: true }))).toBe(false)
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
		const c = fileNamed("c.exe")
		const d = fileNamed("d.png")

		expect(previewableSiblings([a, b, c, d])).toEqual([a, d])
	})

	it("returns an empty array when nothing is previewable", () => {
		expect(previewableSiblings([dirItem(), fileNamed("a.exe")])).toEqual([])
	})

	// The preview arrows step onto an archive and open its browser.
	it("includes archives, whatever their size", () => {
		const image = fileNamed("a.jpg")
		const zip = fileNamed("b.zip")
		const tarball = fileNamed("c.tar.gz", { size: 50n * 1024n ** 3n })

		expect(previewableSiblings([image, zip, tarball])).toEqual([image, zip, tarball])
	})

	it("returns every item when all are previewable", () => {
		const a = fileNamed("a.jpg")
		const b = fileNamed("b.png")

		expect(previewableSiblings([a, b])).toEqual([a, b])
	})

	// Audio is deliberately excluded from the pager: a drive-hosted audio file hands off to the
	// persistent player, so the overlay never renders or pages to it. Stepping through a mixed folder
	// skips audio and the pager count reflects only the non-audio previewables.
	it("excludes audio files even though they are otherwise previewable", () => {
		const image = fileNamed("a.jpg")
		const song = fileNamed("track.mp3", { mime: "audio/mpeg" })
		const pdf = fileNamed("doc.pdf")

		const siblings = previewableSiblings([image, song, pdf])

		expect(siblings).toEqual([image, pdf])
		expect(siblings).toHaveLength(2)
	})

	it("returns an empty pager for an audio-only folder", () => {
		const one = fileNamed("one.mp3", { mime: "audio/mpeg" })
		const two = fileNamed("two.flac", { mime: "audio/flac" })

		expect(previewableSiblings([one, two])).toEqual([])
	})

	// Only its read says what a `.key` is: before it ran it resolves "other", yet it opens, and the gate reads it.
	it("includes a file waiting on its content read, and drops one the read found to be nothing", () => {
		const report = fileNamed("report.pages", { mime: "application/vnd.apple.pages" })
		const slides = fileNamed("unread-slides.key")
		const keynote = fileNamed("read-slides.key")
		const keyFile = fileNamed("server.key")

		recordFileKindVerdict(keynote.data.uuid, "iworkPackage")
		recordFileKindVerdict(keyFile.data.uuid, "notIworkPackage")

		expect(previewType(slides)).toBe("other")
		expect(previewableSiblings([report, slides, keynote, keyFile])).toEqual([report, slides, keynote])
	})
})

describe("previewOpenTarget", () => {
	it("opens the item at its place among the pager's siblings", () => {
		const bare = fileNamed("a-bare.pages", { mime: "application/vnd.apple.pages" })
		const song = fileNamed("b-song.mp3", { mime: "audio/mpeg" })
		const slides = fileNamed("c-slides.key")

		expect(previewOpenTarget([bare, song, slides], slides)).toEqual({ siblings: [bare, slides], index: 1 })
	})

	it("opens an item the pager does not hold alone, never its first sibling", () => {
		const image = fileNamed("a.jpg")
		const song = fileNamed("b.mp3", { mime: "audio/mpeg" })

		expect(previewOpenTarget([image, song], song)).toEqual({ siblings: [song], index: 0 })
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

// Pins the pager's windowing contract at the size a real large directory can reach: opening the
// preview must never fan out per-sibling work. previewOverlay.tsx only ever reads `items[index]`
// (a single array index, O(1)) and `items.length` (also O(1)) from the frozen snapshot this module
// hands it — no viewer component ever receives the sibling array itself, only the one active
// DriveItem. The only per-navigation cost living in THIS module is stepPreviewIndex's own uuid scan,
// which these tests hold to a plain, synchronous index derivation — never a per-sibling
// allocation/transform/IO — even across a many-thousand-item directory.
describe("pager windowing stays cheap over a very large directory", () => {
	const SIBLING_COUNT = 20_000

	function buildLargeSiblingSet(): DriveItem[] {
		// Every other entry is a non-previewable directory, mirroring a real mixed listing —
		// previewableSiblings (the one-time, open-time filter) must still land on exactly the file half.
		return Array.from({ length: SIBLING_COUNT }, (_, i) => (i % 2 === 0 ? fileNamed(`sibling-${String(i)}.jpg`) : dirItem()))
	}

	it("previewableSiblings filters without cloning — surviving entries stay the SAME object references", () => {
		const raw = buildLargeSiblingSet()
		const siblings = previewableSiblings(raw)

		expect(siblings).toHaveLength(SIBLING_COUNT / 2)

		// Reference equality (not deep equality) at three spread-out positions — a filter that instead
		// mapped/cloned each surviving item would still pass a toEqual check but fail this one, which is
		// exactly the per-sibling materialization this test exists to catch.
		expect(siblings[0]).toBe(raw[0])
		expect(siblings[Math.floor(siblings.length / 2)]).toBe(raw[SIBLING_COUNT / 2])
		expect(siblings.at(-1)).toBe(raw.at(-2))
	})

	it("stepPreviewIndex is a synchronous, plain-number derivation — never an awaitable/IO-shaped result", () => {
		const siblings = previewableSiblings(buildLargeSiblingSet())
		const middle = siblings[Math.floor(siblings.length / 2)]

		if (!middle) {
			throw new Error("fixture setup produced no middle sibling")
		}

		const result: unknown = stepPreviewIndex(middle.data.uuid, siblings, 1)

		// A step that instead fetched or decrypted per-sibling data would have to return a Promise —
		// this stays a plain number precisely because it never does.
		expect(typeof result).toBe("number")
		expect(result).not.toBeInstanceOf(Promise)
	})

	it("resolves the correct index from any position across the full sibling range, forward and back", () => {
		const siblings = previewableSiblings(buildLargeSiblingSet())
		const last = siblings.length - 1
		const checkpoints = [0, 1, Math.floor(siblings.length / 2), last - 1, last]

		for (const position of checkpoints) {
			const current = siblings[position]

			if (!current) {
				throw new Error(`fixture setup missing sibling at checkpoint ${String(position)}`)
			}

			expect(stepPreviewIndex(current.data.uuid, siblings, 1)).toBe(Math.min(position + 1, last))
			expect(stepPreviewIndex(current.data.uuid, siblings, -1)).toBe(Math.max(position - 1, 0))
		}
	})

	it("a long run of consecutive steps across the whole set lands on the same items the array already holds", () => {
		const siblings = previewableSiblings(buildLargeSiblingSet())
		let index = 0

		// Walks every slot forward, then all the way back — each step re-derives its target purely from
		// the current item's uuid (stepPreviewIndex's own contract), never from an accumulated,
		// separately-materialized window. Landing back on siblings[0] by reference proves no sibling
		// along the way was replaced, copied, or dropped by the walk itself.
		for (let step = 0; step < siblings.length - 1; step++) {
			const current = siblings[index]

			if (!current) {
				throw new Error(`walk lost its footing at index ${String(index)}`)
			}

			index = stepPreviewIndex(current.data.uuid, siblings, 1)
		}

		expect(index).toBe(siblings.length - 1)

		for (let step = 0; step < siblings.length - 1; step++) {
			const current = siblings[index]

			if (!current) {
				throw new Error(`walk lost its footing at index ${String(index)}`)
			}

			index = stepPreviewIndex(current.data.uuid, siblings, -1)
		}

		expect(index).toBe(0)
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

describe("codeMirrorLanguageFor — extension to CodeMirror language tag", () => {
	// The full code-extension set (CODE_FILE_EXTENSIONS) mapped to its language, or "" when no grammar
	// covers it (still a fully usable read-only plain-text view, just unhighlighted).
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
		vue: "vue",
		svelte: "svelte",
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

	// Beyond the code category: a file opened as text (or a note named so) gets its grammar too.
	it.each([
		["scala", "scala"],
		["hs", "haskell"],
		["tex", "latex"],
		["yml", "yaml"],
		["scss", "scss"],
		["nix", "nix"]
	])("%s -> %s", (ext, expected) => {
		expect(codeMirrorLanguageFor(ext)).toBe(expected)
	})

	it('returns "" for an inherited object key', () => {
		expect(codeMirrorLanguageFor("constructor")).toBe("")
		expect(codeMirrorLanguageFor("__proto__")).toBe("")
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

describe("extensionless text/* files", () => {
	it("keep the category their type names on web, the plain-text fallback never reached", () => {
		for (const [mime, extension, direction] of TYPE_ROWS) {
			if (direction !== "fromExt" && mime.startsWith("text/")) {
				expect(fileTypeExtension("notes", mime)).toBe(extension)
			}
		}

		expect(previewType(fileNamed("export", { mime: "text/csv" }))).toBe("spreadsheet")
		expect(previewType(fileNamed("notes", { mime: "text/x-unknown-thing" }))).toBe("text")
	})
})
