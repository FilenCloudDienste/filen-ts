import type { DirColor } from "@filen/sdk-rs"
import { extensionOf, IMAGE_EXTENSIONS, HEIC_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from "@/features/drive/lib/preview.logic"
import { dirColorHex } from "@/features/drive/lib/dirColor"

// The concrete file-type glyphs in src/assets/file-icons/ (byte-identical to filen-mobile's set) a
// file routes to. "other" is the generic fallback: an unknown extension, or an undecryptable file
// whose name — and thus extension — is unavailable.
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

// Ported from filen-mobile's itemIcons code list (getPreviewType's code arm) — a superset of
// preview.logic's CODE_EXTENSIONS (adds md/log/ini/makefile/mk/gradle/lua) so a file's icon matches
// mobile even where this app previews the same file in a different (markdown/text) category.
const CODE_EXTENSIONS = new Set([
	"js",
	"cjs",
	"mjs",
	"jsx",
	"tsx",
	"ts",
	"md",
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
	"log",
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
])

const ARCHIVE_EXTENSIONS = new Set(["pkg", "rar", "tar", "zip", "7zip"])

// Resolves a file name to its type-icon key. Preview-type first (image/video/audio/pdf/txt/docx), then
// a per-extension switch — the same order filen-mobile's FileIcon uses, so the two platforms route
// identically. An empty name (an undecryptable file, no extension to read) falls through to "other".
export function fileIconKey(name: string): FileIconKey {
	const ext = extensionOf(name)

	if (IMAGE_EXTENSIONS.has(ext) || HEIC_EXTENSIONS.has(ext)) {
		return "image"
	}

	if (VIDEO_EXTENSIONS.has(ext)) {
		return "video"
	}

	if (AUDIO_EXTENSIONS.has(ext)) {
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

// Darkens a hex color channel-wise (divide each channel by `divisor`, clamp to 255) — ported from
// filen-mobile's shadeColor; the folder tab uses a darker shade of the body color.
export function shadeColor(hex: string, divisor: number): string {
	const start = hex.startsWith("#") ? 1 : 0
	const channel = (offset: number): number =>
		Math.min(255, Math.round(parseInt(hex.slice(start + offset, start + offset + 2), 16) / divisor))
	const toHex = (value: number): string => value.toString(16).padStart(2, "0")

	return `#${toHex(channel(0))}${toHex(channel(2))}${toHex(channel(4))}`
}

// The two folder-glyph fills for a directory: body = the resolved DirColor hex, tab = a darker shade of
// it. The named "default" keeps filen-mobile's exact default pair (not a shade of the default body) so
// an uncolored directory reads identically across platforms.
export function directoryFolderTint(color: DirColor): { path1: string; path2: string } {
	if (color === "default") {
		return { path1: "#5398DF", path2: "#85BCFF" }
	}

	const hex = dirColorHex(color)

	return { path1: shadeColor(hex, 1.3), path2: hex }
}
