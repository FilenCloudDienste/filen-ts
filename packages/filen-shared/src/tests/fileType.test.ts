import { describe, expect, it } from "vitest"
import {
	canonicalInlineType,
	extensionForExactFileName,
	extensionForFileName,
	extensionForMime,
	extensionStart,
	FILE_NAME_TYPES,
	mimeForExtension,
	TYPE_ROWS
} from "@filen/shared"

describe("extensionForFileName", () => {
	it("reads extension-less well-known names, case-insensitively", () => {
		expect(extensionForFileName("LICENSE")).toBe("txt")
		expect(extensionForFileName("Makefile")).toBe("makefile")
		expect(extensionForFileName("Dockerfile")).toBe("dockerfile")
		expect(extensionForFileName("Gemfile")).toBe("rb")
	})

	it("reads known dotfiles, and every .env variant", () => {
		expect(extensionForFileName(".gitignore")).toBe("txt")
		expect(extensionForFileName(".bashrc")).toBe("sh")
		expect(extensionForFileName(".env")).toBe("ini")
		expect(extensionForFileName(".env.production")).toBe("ini")
	})

	it("leaves unknown names and binary dotfiles alone", () => {
		expect(extensionForFileName("notes")).toBeNull()
		expect(extensionForFileName(".DS_Store")).toBeNull()
	})
})

describe("extensionForMime", () => {
	it("maps a MIME type, ignoring case and parameters", () => {
		expect(extensionForMime("image/JPEG")).toBe("jpg")
		expect(extensionForMime("application/json; charset=utf-8")).toBe("json")
	})

	it("reads an audiobook's type as m4b", () => {
		expect(extensionForMime("audio/x-m4b")).toBe("m4b")
		expect(extensionForMime("audio/mp4")).toBe("m4a")
	})

	it("keeps the macro-enabled workbook type apart from plain .xlsx", () => {
		expect(extensionForMime("application/vnd.ms-excel.sheet.macroEnabled.12")).toBe("xlsm")
	})

	it("reads macro-enabled Word documents and Word templates by their own types", () => {
		expect(extensionForMime("application/vnd.ms-word.document.macroEnabled.12")).toBe("docm")
		expect(extensionForMime("application/vnd.openxmlformats-officedocument.wordprocessingml.template")).toBe("dotx")
		expect(extensionForMime("application/vnd.ms-word.template.macroEnabled.12")).toBe("dotm")
	})

	it("reads a transport stream's type as m2ts, never TypeScript's .ts", () => {
		expect(extensionForMime("video/mp2t")).toBe("m2ts")
		expect(extensionForMime("video/vnd.dlna.mpeg-tts")).toBe("m2ts")
	})

	it("reads any other text type as plain text", () => {
		expect(extensionForMime("text/x-unknown-thing")).toBe("txt")
	})

	it("knows nothing about an absent or opaque type", () => {
		expect(extensionForMime(undefined)).toBeNull()
		expect(extensionForMime("")).toBeNull()
		expect(extensionForMime("application/octet-stream")).toBeNull()
	})
})

// Rows added after the hand-written map.
const MIME_TYPES_ADDED: readonly (readonly [string, string])[] = [
	["image/pjpeg", "jpg"],
	["image/x-png", "png"],
	["text/vtt", "vtt"],
	["application/x-subrip", "srt"],
	["text/calendar", "ics"],
	["text/vcard", "vcf"],
	["text/x-vcard", "vcf"],
	["message/rfc822", "eml"],
	["application/mbox", "mbox"],
	["application/zip", "zip"],
	["application/x-zip-compressed", "zip"],
	["application/x-7z-compressed", "7z"],
	["application/x-tar", "tar"],
	["application/gzip", "gz"],
	["application/x-gzip", "gz"],
	["application/x-bzip2", "bz2"],
	["application/x-xz", "xz"],
	["application/zstd", "zst"],
	["application/java-archive", "jar"],
	["application/vnd.android.package-archive", "apk"],
	["application/x-xpinstall", "xpi"],
	["font/ttf", "ttf"],
	["application/x-font-ttf", "ttf"],
	["font/otf", "otf"],
	["font/woff", "woff"],
	["application/font-woff", "woff"],
	["font/woff2", "woff2"],
	["application/gpx+xml", "gpx"],
	["application/vnd.google-earth.kml+xml", "kml"],
	["application/vnd.google-earth.kmz", "kmz"],
	["application/geo+json", "geojson"],
	["model/stl", "stl"],
	["model/obj", "obj"],
	["model/gltf+json", "gltf"],
	["model/gltf-binary", "glb"],
	["model/3mf", "3mf"],
	["model/vnd.usdz+zip", "usdz"],
	["application/x-bittorrent", "torrent"],
	["application/vnd.sqlite3", "sqlite"],
	["application/x-sqlite3", "sqlite"],
	["application/epub+zip", "epub"],
	["application/x-mobipocket-ebook", "mobi"],
	["application/x-fictionbook+xml", "fb2"],
	["image/jxl", "jxl"],
	["image/x-qoi", "qoi"],
	["application/illustrator", "ai"],
	["image/vnd.adobe.photoshop", "psd"]
]

// The MIME type → extension map as it was written by hand before TYPE_ROWS: the derived one must equal it.
const MIME_TYPES_SNAPSHOT: readonly (readonly [string, string])[] = [
	["image/jpeg", "jpg"],
	["image/png", "png"],
	["image/gif", "gif"],
	["image/webp", "webp"],
	["image/svg+xml", "svg"],
	["image/bmp", "bmp"],
	["image/x-icon", "ico"],
	["image/vnd.microsoft.icon", "ico"],
	["image/apng", "apng"],
	["image/avif", "avif"],
	["image/heic", "heic"],
	["image/heic-sequence", "heic"],
	["image/heif", "heif"],
	["image/heif-sequence", "heif"],
	["image/tiff", "tiff"],
	["video/mp4", "mp4"],
	["video/webm", "webm"],
	["video/quicktime", "mov"],
	["video/x-matroska", "mkv"],
	["video/x-m4v", "m4v"],
	["video/mp2t", "m2ts"],
	["video/vnd.dlna.mpeg-tts", "m2ts"],
	["video/3gpp", "3gp"],
	["video/3gpp2", "3g2"],
	["audio/mpeg", "mp3"],
	["audio/mp3", "mp3"],
	["audio/mp4", "m4a"],
	["audio/x-m4a", "m4a"],
	["audio/x-m4b", "m4b"],
	["audio/aac", "aac"],
	["audio/wav", "wav"],
	["audio/wave", "wav"],
	["audio/x-wav", "wav"],
	["audio/ogg", "ogg"],
	["audio/flac", "flac"],
	["audio/x-flac", "flac"],
	["audio/opus", "opus"],
	["audio/aiff", "aiff"],
	["audio/x-aiff", "aiff"],
	["audio/amr", "amr"],
	["audio/x-caf", "caf"],
	["application/pdf", "pdf"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
	["application/vnd.ms-word.document.macroenabled.12", "docm"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.template", "dotx"],
	["application/vnd.ms-word.template.macroenabled.12", "dotm"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
	["application/vnd.ms-excel.sheet.macroenabled.12", "xlsm"],
	["application/vnd.ms-excel", "xls"],
	["application/vnd.apple.pages", "pages"],
	["application/vnd.apple.numbers", "numbers"],
	["text/csv", "csv"],
	["text/tab-separated-values", "tsv"],
	["text/markdown", "md"],
	["text/x-markdown", "md"],
	["text/plain", "txt"],
	["application/json", "json"],
	["application/ld+json", "json"],
	["application/xml", "xml"],
	["text/xml", "xml"],
	["application/javascript", "js"],
	["application/x-javascript", "js"],
	["text/javascript", "js"],
	["application/typescript", "ts"],
	["text/css", "css"],
	["text/html", "html"],
	["application/x-sh", "sh"],
	["application/x-shellscript", "sh"],
	["text/x-shellscript", "sh"],
	["application/yaml", "yaml"],
	["application/x-yaml", "yaml"],
	["text/yaml", "yaml"],
	["text/x-yaml", "yaml"],
	["application/toml", "toml"],
	["application/sql", "sql"],
	["text/x-python", "py"],
	["text/x-c", "c"],
	["text/x-c++", "cpp"],
	["text/x-java-source", "java"],
	["text/x-php", "php"],
	["application/x-httpd-php", "php"],
	["text/x-go", "go"],
	["text/x-rust", "rs"]
]

// The extension → audio type map web's inline route served before TYPE_ROWS.
const AUDIO_TYPES_SNAPSHOT: readonly (readonly [string, string])[] = [
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
]

describe("TYPE_ROWS", () => {
	it("gives each MIME type at most one extension and each extension at most one MIME type", () => {
		const toExt = TYPE_ROWS.filter(([, , direction]) => direction !== "fromExt").map(([mime]) => mime)
		const fromExt = TYPE_ROWS.filter(([, , direction]) => direction !== "toExt").map(([, extension]) => extension)

		expect(new Set(toExt).size).toBe(toExt.length)
		expect(new Set(fromExt).size).toBe(fromExt.length)
	})

	it("writes every row lowercase and parameter-free", () => {
		for (const [mime, extension] of TYPE_ROWS) {
			expect(mime).toBe(mime.toLowerCase())
			expect(mime).not.toContain(";")
			expect(extension).toBe(extension.toLowerCase())
		}
	})

	it("reads every MIME type as the hand-written map did, plus the aliases added since, and no other", () => {
		const derived = new Map(
			TYPE_ROWS.filter(([, , direction]) => direction !== "fromExt").map(([mime, extension]) => [mime, extension])
		)

		expect(derived).toEqual(new Map([...MIME_TYPES_SNAPSHOT, ...MIME_TYPES_ADDED]))

		for (const [mime, extension] of MIME_TYPES_SNAPSHOT) {
			expect(extensionForMime(mime)).toBe(extension)
		}
	})

	it("serves each audio extension as web's inline route did", () => {
		for (const [extension, mime] of AUDIO_TYPES_SNAPSHOT) {
			expect(mimeForExtension(extension)).toBe(mime)
		}
	})
})

describe("e-book types", () => {
	it("reads and serves EPUB, MOBI and FB2 by their own types", () => {
		expect(extensionForMime("application/epub+zip")).toBe("epub")
		expect(extensionForMime("application/x-mobipocket-ebook")).toBe("mobi")
		expect(extensionForMime("application/x-fictionbook+xml")).toBe("fb2")
		expect(mimeForExtension("epub")).toBe("application/epub+zip")
		expect(mimeForExtension("mobi")).toBe("application/x-mobipocket-ebook")
		expect(mimeForExtension("fb2")).toBe("application/x-fictionbook+xml")
	})
})

describe("mimeForExtension", () => {
	it("serves the image extensions the preview decodes itself", () => {
		expect(mimeForExtension("tif")).toBe("image/tiff")
		expect(mimeForExtension("jxl")).toBe("image/jxl")
		expect(mimeForExtension("qoi")).toBe("image/x-qoi")
		expect(mimeForExtension("svgz")).toBe("image/svg+xml")
		expect(extensionForMime("image/svg+xml")).toBe("svg")
		expect(extensionForMime("image/tiff")).toBe("tiff")
		expect(mimeForExtension("psd")).toBe("image/vnd.adobe.photoshop")
		expect(mimeForExtension("psb")).toBe("image/vnd.adobe.photoshop")
		expect(mimeForExtension("eps")).toBe("application/postscript")
		// An extensionless upload stored as a Photoshop file reads as one; PostScript stays generic.
		expect(extensionForMime("image/vnd.adobe.photoshop")).toBe("psd")
		expect(extensionForMime("application/postscript")).toBeNull()
	})

	it("serves an extension as its canonical type, never an alias", () => {
		expect(mimeForExtension("jpg")).toBe("image/jpeg")
		expect(mimeForExtension("jpeg")).toBe("image/jpeg")
		expect(mimeForExtension("ico")).toBe("image/x-icon")
		for (const alias of ["jfif", "jpe", "pjpeg", "pjp"]) {
			expect(mimeForExtension(alias)).toBe("image/jpeg")
		}
		expect(mimeForExtension("opus")).toBe("audio/ogg")
		expect(mimeForExtension("wav")).toBe("audio/wav")
	})

	it("serves every HEIF name as a HEIF type, and reads no type as .hif", () => {
		expect(mimeForExtension("heic")).toBe("image/heic")
		expect(mimeForExtension("heif")).toBe("image/heif")
		expect(mimeForExtension("hif")).toBe("image/heif")
		expect(extensionForMime("image/heif")).toBe("heif")
	})

	it("serves subtitles, calendars, contacts and mail as their own types", () => {
		expect(mimeForExtension("vtt")).toBe("text/vtt")
		expect(mimeForExtension("srt")).toBe("application/x-subrip")
		expect(mimeForExtension("ics")).toBe("text/calendar")
		expect(mimeForExtension("vcf")).toBe("text/vcard")
		expect(mimeForExtension("eml")).toBe("message/rfc822")
		expect(mimeForExtension("mbox")).toBe("application/mbox")
		expect(extensionForMime("text/x-vcard")).toBe("vcf")
	})

	it("has nothing for an extension no row serves", () => {
		expect(mimeForExtension("mka")).toBeNull()
		expect(mimeForExtension("JPG")).toBeNull()
		expect(mimeForExtension("")).toBeNull()
	})
})

describe("canonicalInlineType", () => {
	it("maps an alias to its canonical type", () => {
		expect(canonicalInlineType("image/vnd.microsoft.icon")).toBe("image/x-icon")
		expect(canonicalInlineType("image/pjpeg")).toBe("image/jpeg")
		expect(canonicalInlineType("image/x-png")).toBe("image/png")
		expect(canonicalInlineType("audio/x-wav")).toBe("audio/wav")
		expect(canonicalInlineType("Audio/X-FLAC; codecs=flac")).toBe("audio/flac")
		expect(canonicalInlineType("audio/opus")).toBe("audio/ogg")
	})

	it("keeps a canonical type and has nothing for an unknown one", () => {
		expect(canonicalInlineType("image/jpeg")).toBe("image/jpeg")
		expect(canonicalInlineType("application/octet-stream")).toBeNull()
		expect(canonicalInlineType("text/x-unknown-thing")).toBeNull()
	})
})

describe("extensionForExactFileName", () => {
	// Asked before the extension: a name without one changes nothing, so only the names below override an extension.
	const OVERRIDES_AN_EXTENSION = new Set(["go.mod", "go.sum", "go.work"])

	it("names files without an extension, and only these over the one their name has", () => {
		for (const [name, extension] of FILE_NAME_TYPES) {
			expect(extensionStart(name) === -1, name).toBe(!OVERRIDES_AN_EXTENSION.has(name))
			expect(extensionForExactFileName(name.toUpperCase())).toBe(extension)
		}
	})

	it("reads Go's module, checksum and workspace files as plain text, never their extension", () => {
		expect(extensionForExactFileName("go.mod")).toBe("txt")
		expect(extensionForExactFileName("project/go.sum")).toBe("txt")
		expect(extensionForExactFileName("GO.WORK")).toBe("txt")
		expect(extensionForExactFileName("other.mod")).toBeNull()
	})

	it("leaves the .env.* prefix rule to extensionForFileName", () => {
		expect(extensionForExactFileName(".env.production")).toBeNull()
		expect(extensionForFileName(".env.production")).toBe("ini")
	})
})
