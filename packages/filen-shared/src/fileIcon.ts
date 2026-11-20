import { CODE_FILE_EXTENSIONS } from "./fileExtensions"

// The concrete file-type glyphs both apps ship (byte-identical asset sets) a file routes to. "other"
// is the generic fallback: an unknown extension, or an undecryptable file whose name — and thus
// extension — is unavailable.
export type FileIconKey =
	| "image"
	| "video"
	| "audio"
	| "pdf"
	| "txt"
	| "doc"
	| "ppt"
	| "xls"
	| "code"
	| "archive"
	| "exe"
	| "iso"
	| "cad"
	| "psd"
	| "android"
	| "apple"
	| "other"

// Per-app image/video/audio membership, injected rather than owned here: each app's decode-capability
// coverage for these three buckets differs (and is out of scope for this classifier to unify), so the
// classifier only asks "does this extension belong to your image/video/audio set" and stays agnostic
// to what that set contains.
export type FileIconSets = {
	isImage: (ext: string) => boolean
	isVideo: (ext: string) => boolean
	isAudio: (ext: string) => boolean
}

function rows(key: FileIconKey, extensions: readonly string[]): (readonly [string, FileIconKey])[] {
	return extensions.map(extension => [extension, key] as const)
}

// Every non-media, non-code extension plus the extensions this ICON classifier treats as code even
// where an app's own PREVIEW category splits them out (md/markdown/log — none of which are in the
// shared preview set; see CODE_FILE_EXTENSIONS' own comment). Groups are disjoint, so a single lookup
// replaces an ordered chain.
const ICON_KEY_BY_EXTENSION: ReadonlyMap<string, FileIconKey> = new Map<string, FileIconKey>([
	["pdf", "pdf"],
	["txt", "txt"],
	["doc", "doc"],
	["docx", "doc"],
	["docm", "doc"],
	["dotx", "doc"],
	["dotm", "doc"],
	// Word 97–2003 templates, OpenDocument text and its templates, and rich text.
	...rows("doc", ["dot", "odt", "ott", "rtf"]),
	["ppt", "ppt"],
	["pptx", "ppt"],
	["pptm", "ppt"],
	["potx", "ppt"],
	["potm", "ppt"],
	["ppsx", "ppt"],
	["ppsm", "ppt"],
	["pps", "ppt"],
	["pot", "ppt"],
	["odp", "ppt"],
	["otp", "ppt"],
	["xls", "xls"],
	["xlsx", "xls"],
	["xlsm", "xls"],
	["xltx", "xls"],
	["xltm", "xls"],
	["xlt", "xls"],
	["csv", "xls"],
	["tsv", "xls"],
	["tab", "xls"],
	// OpenDocument spreadsheets and their templates.
	...rows("xls", ["ods", "ots"]),
	["dmg", "iso"],
	["iso", "iso"],
	["cad", "cad"],
	["psd", "psd"],
	["apk", "android"],
	["ipa", "apple"],
	["pkg", "archive"],
	["rar", "archive"],
	["tar", "archive"],
	["zip", "archive"],
	["7zip", "archive"],
	["7z", "archive"],
	["gz", "archive"],
	["tgz", "archive"],
	["xz", "archive"],
	["txz", "archive"],
	["bz2", "archive"],
	["tbz", "archive"],
	["tbz2", "archive"],
	["tb2", "archive"],
	["zst", "archive"],
	["tzst", "archive"],
	["lz4", "archive"],
	["br", "archive"],
	["lz", "archive"],
	["lzma", "archive"],
	["tlz", "archive"],
	["jar", "exe"],
	["exe", "exe"],
	["bin", "exe"],
	...rows("archive", [
		"aab",
		"aar",
		"war",
		"ear",
		"xpi",
		"crx",
		"whl",
		"nupkg",
		"vsix",
		"appx",
		"msix",
		"kmz",
		"cbz",
		"cbt",
		"cb7",
		"cbr"
	]),
	// An Outlook message (.msg) is a binary compound file, a document rather than text.
	...rows("doc", ["epub", "mobi", "fb2", "pages", "msg"]),
	["numbers", "xls"],
	...rows("txt", ["eml", "mbox", "ics", "ifb", "ical", "vcf", "vcard", "srt", "vtt", "ass", "ssa", "smi", "sami"]),
	...rows("code", ["ipynb", "gpx", "kml", "geojson", "mmd", "excalidraw"]),
	...rows("cad", ["stl", "gltf", "glb", "3mf", "fbx", "ply", "usdz", "dxf"]),
	...rows("audio", ["mid", "midi", "kar", "rmi", "xm", "s3m", "mptm", "wma"]),
	...rows("image", ["dcm", "dicom"]),
	...rows("psd", ["psb", "ai", "eps"]),
	...rows("exe", ["dll", "msi", "sys", "efi", "scr", "ocx", "cpl", "elf", "so", "ko", "axf", "dylib"]),
	...rows("iso", ["img", "vhdx", "vmdk"]),
	["md", "code"],
	["markdown", "code"],
	["log", "code"]
])

// Extensions only a read of the file gives a meaning (fileKind.ts): their glyph once the read found that meaning, the
// generic one before. A `.key` is a Keynote package or a key file.
const READ_ICON_KEY_BY_EXTENSION: ReadonlyMap<string, FileIconKey> = new Map<string, FileIconKey>([["key", "ppt"]])

// Resolves an already-normalised extension (lowercase, no leading dot) to its type-icon key.
// image/video/audio are resolved first via the injected `sets`, then the fixed table, then the shared
// code set. An extension matching nothing (including "", an undecryptable file with no name to read
// one from) falls through to "other". `readFound`: a read of the file's content found what its extension means (a
// verdict gave it its kind), which an extension only a read gives a meaning needs for its glyph.
export function fileIconKey(ext: string, sets: FileIconSets, readFound = false): FileIconKey {
	const read = READ_ICON_KEY_BY_EXTENSION.get(ext)

	if (read !== undefined) {
		return readFound ? read : "other"
	}

	if (sets.isImage(ext)) {
		return "image"
	}

	if (sets.isVideo(ext)) {
		return "video"
	}

	if (sets.isAudio(ext)) {
		return "audio"
	}

	return ICON_KEY_BY_EXTENSION.get(ext) ?? (CODE_FILE_EXTENSIONS.has(ext) ? "code" : "other")
}
