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

export const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set(["pkg", "rar", "tar", "zip", "7zip"])

// CODE_FILE_EXTENSIONS (the 53-entry preview intersection) plus the extensions this ICON classifier
// treats as code even where an app's own PREVIEW category splits some of them out (md/markdown/log/
// ahk — none of which are in the shared preview set; see CODE_FILE_EXTENSIONS' own comment).
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([...CODE_FILE_EXTENSIONS, "md", "markdown", "log", "ahk"])

// Resolves an already-normalised extension (lowercase, no leading dot) to its type-icon key.
// image/video/audio are resolved first via the injected `sets`, then a fixed per-extension table for
// everything both apps agree on exactly. An extension matching nothing (including "", an undecryptable
// file with no name to read one from) falls through to "other".
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

	if (ext === "pdf") {
		return "pdf"
	}

	if (ext === "txt") {
		return "txt"
	}

	if (ext === "doc" || ext === "docx") {
		return "doc"
	}

	if (ext === "dmg" || ext === "iso") {
		return "iso"
	}

	if (ext === "cad") {
		return "cad"
	}

	if (ext === "psd") {
		return "psd"
	}

	if (ext === "apk") {
		return "android"
	}

	if (ext === "ipa") {
		return "apple"
	}

	if (ARCHIVE_EXTENSIONS.has(ext)) {
		return "archive"
	}

	if (CODE_EXTENSIONS.has(ext)) {
		return "code"
	}

	if (ext === "jar" || ext === "exe" || ext === "bin") {
		return "exe"
	}

	if (ext === "ppt" || ext === "pptx") {
		return "ppt"
	}

	if (ext === "xls" || ext === "xlsx") {
		return "xls"
	}

	return "other"
}
