import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import type { DriveVariant } from "@/lib/drive/preferences"
import { clampListboxIndex } from "@/lib/drive/listbox"

// Every previewable file resolves to one of these; "other" is the download-only fallback (no viewer,
// ever — canPreview excludes it unconditionally).
export type PreviewCategory = "image" | "video" | "audio" | "pdf" | "docx" | "text" | "code" | "markdown" | "other"

// Whole-buffer preview memory ceiling (old-web's MAX_PREVIEW_SIZE_WEB precedent): image/pdf/docx/text/
// code/markdown download fully into RAM before rendering, so an oversize file is excluded from
// canPreview rather than risking a tab-crashing allocation. Media (video/audio) streams via the service
// worker's Range route instead and is never bounded by this.
export const PREVIEW_MAX_BYTES = 268_435_456n // 256 MiB

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "apng", "avif"])
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mkv", "mov", "m4v"])
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"])
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"])
const TEXT_EXTENSIONS = new Set(["txt", "log"])
// Mirrors filen-mobile's previewType.ts code-extension set (itself ported from old-web), minus the two
// extensions this app buckets into their own, richer-rendered category instead: .md (-> markdown) and
// .log (-> text).
const CODE_EXTENSIONS = new Set([
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
])

// Deliberately absent from IMAGE_EXTENSIONS: HEIC/HEIF have no native browser decode path — they fall
// through to "other" (download-only) rather than a broken <img> render.

// Lowercased extension with no leading dot; "" when the name has none (including a dotfile like
// ".gitignore", where the only "." is the leading one — not a real extension).
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".")

	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ""
}

function categoryForExtension(ext: string): PreviewCategory | null {
	if (IMAGE_EXTENSIONS.has(ext)) {
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

	if (ext === "docx") {
		return "docx"
	}

	if (MARKDOWN_EXTENSIONS.has(ext)) {
		return "markdown"
	}

	if (TEXT_EXTENSIONS.has(ext)) {
		return "text"
	}

	if (CODE_EXTENSIONS.has(ext)) {
		return "code"
	}

	return null
}

// Coarse mime fallback for a name whose extension resolved no category — no mime-map dependency
// exists in this app yet, and a handful of prefix checks doesn't warrant adding one, so this covers
// the broad strokes only; the extension map above is the primary, exhaustive path.
function categoryForMime(mime: string): PreviewCategory | null {
	const normalized = mime.toLowerCase().trim()

	if (normalized.startsWith("image/")) {
		return "image"
	}

	if (normalized.startsWith("video/")) {
		return "video"
	}

	if (normalized.startsWith("audio/")) {
		return "audio"
	}

	if (normalized === "application/pdf") {
		return "pdf"
	}

	if (normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
		return "docx"
	}

	if (normalized === "text/markdown") {
		return "markdown"
	}

	if (normalized.startsWith("text/")) {
		return "text"
	}

	return null
}

// Extension-first, mime-fallback category resolution. A directory (or a shared-directory arm, which
// asDirectoryOrFile normalizes to one) always resolves "other" — there is nothing to preview.
export function previewType(item: DriveItem): PreviewCategory {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return "other"
	}

	const name = base.data.decryptedMeta?.name
	const byExtension = name !== undefined ? categoryForExtension(extensionOf(name)) : null

	if (byExtension !== null) {
		return byExtension
	}

	const mime = base.data.decryptedMeta?.mime
	const byMime = mime !== undefined ? categoryForMime(mime) : null

	return byMime ?? "other"
}

const STREAMED_CATEGORIES = new Set<PreviewCategory>(["video", "audio"])

// Gate for opening a preview: a file, decryptable, resolves to a real category, and — for a
// whole-buffer category only — under the memory cap (streamed media is never capped). Trash is NOT
// excluded — a trashed file still previews, read-only, mirroring mobile — `variant` is threaded for a
// later trash-exclusion/editability override, not consulted by this base gate.
export function canPreview(item: DriveItem, variant: DriveVariant): boolean {
	void variant

	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return false
	}

	const category = previewType(item)

	if (category === "other") {
		return false
	}

	if (STREAMED_CATEGORIES.has(category)) {
		return true
	}

	return base.data.size <= PREVIEW_MAX_BYTES
}

// The pager's candidate list — every previewable item in a listing, in the listing's own sorted order
// (no re-sort of its own; the caller's array is already in display order).
export function previewableSiblings(items: DriveItem[], variant: DriveVariant): DriveItem[] {
	return items.filter(item => canPreview(item, variant))
}

// Resolves the sibling one step (no wrap) from whichever sibling currently carries `currentUuid` — a
// uuid lookup rather than a plain index+delta so a caller holding only the current item's identity can
// still step correctly even if its position within `siblings` shifted. An unresolvable uuid steps from
// the start of the list.
export function stepPreviewIndex(currentUuid: string, siblings: DriveItem[], delta: 1 | -1): number {
	const currentIndex = siblings.findIndex(sibling => sibling.data.uuid === currentUuid)

	return clampListboxIndex((currentIndex === -1 ? 0 : currentIndex) + delta, siblings.length)
}
