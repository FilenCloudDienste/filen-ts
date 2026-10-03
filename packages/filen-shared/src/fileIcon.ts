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

// Every non-media, non-code extension plus the extensions this ICON classifier treats as code even
// where an app's own PREVIEW category splits them out (md/markdown/log/ahk — none of which are in the
// shared preview set; see CODE_FILE_EXTENSIONS' own comment). Groups are disjoint, so a single lookup
// replaces an ordered chain.
const ICON_KEY_BY_EXTENSION: ReadonlyMap<string, FileIconKey> = new Map<string, FileIconKey>([
	["pdf", "pdf"],
	["txt", "txt"],
	["doc", "doc"],
	["docx", "doc"],
	["ppt", "ppt"],
	["pptx", "ppt"],
	["xls", "xls"],
	["xlsx", "xls"],
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
	["md", "code"],
	["markdown", "code"],
	["log", "code"],
	["ahk", "code"]
])

// Resolves an already-normalised extension (lowercase, no leading dot) to its type-icon key.
// image/video/audio are resolved first via the injected `sets`, then the fixed table, then the shared
// code set. An extension matching nothing (including "", an undecryptable file with no name to read
// one from) falls through to "other".
export function fileIconKey(ext: string, sets: FileIconSets): FileIconKey {
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
