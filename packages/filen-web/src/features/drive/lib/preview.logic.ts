import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { clampListboxIndex } from "@/features/drive/lib/listbox"

// Every previewable file resolves to one of these; "other" is the download-only fallback (no viewer,
// ever — canPreview excludes it unconditionally).
export type PreviewCategory = "image" | "video" | "audio" | "pdf" | "docx" | "text" | "code" | "markdown" | "other"

// Whole-buffer preview memory ceiling (old-web's MAX_PREVIEW_SIZE_WEB precedent): pdf/docx/text/code/
// markdown download fully into RAM before rendering, so an oversize file is excluded from canPreview
// rather than risking a tab-crashing allocation. video/audio/image stream via the service worker's
// inline Range route instead and are never bounded by this — image ALSO keeps a whole-buffer fallback
// (dev / SW absent / stream registration failure) that this cap does not gate either, since the SW's
// own availability isn't known at gating time; an oversize image on that fallback path is an accepted,
// deliberate tradeoff of joining the streamed set, not a regression this cap is meant to catch.
export const PREVIEW_MAX_BYTES = 268_435_456n // 256 MiB

// Exported so icon.logic's file-type routing classifies image/video/audio identically to preview — a
// file's type icon and its preview category can never disagree.
export const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "apng", "avif"])
// HEIC/HEIF resolve to the "image" category below like every other image extension, but browsers
// cannot decode them inline — needsImageTransform/canPreview single them out to route through the
// buffered download + a client-side transform (features/preview/lib/heicTransform.ts) instead of the SW's
// streamed route every other image extension uses.
export const HEIC_EXTENSIONS = new Set(["heic", "heif"])
export const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mkv", "mov", "m4v"])
export const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"])
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

// Lowercased extension with no leading dot; "" when the name has none (including a dotfile like
// ".gitignore", where the only "." is the leading one — not a real extension). Exported for
// textViewer.tsx (resolves a CodeMirror language the same way previewType resolves a category).
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".")

	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ""
}

function categoryForExtension(ext: string): PreviewCategory | null {
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

// image joins video/audio here: all three prefer the SW's inline Range route
// (features/preview/lib/previewStream.ts) and fall whole-buffer only as a capability fallback (dev / SW absent / registration
// failure) — see PREVIEW_MAX_BYTES's own comment on the tradeoff that fallback accepts. HEIC/HEIF are
// the one "image" exception: needsImageTransform below excludes them from ever attempting the
// streamed route at all — canPreview applies the whole-buffer cap to them instead, same as pdf/docx.
const STREAMED_CATEGORIES = new Set<PreviewCategory>(["video", "audio", "image"])

// True for HEIC/HEIF — an "image"-category item that still can't stream, since no browser decodes it
// inline. imageViewer.tsx checks this before ever considering the SW route, routing these through the
// buffered download + a client-side transform (features/preview/lib/heicTransform.ts) instead. Extension-only
// (mirrors how previewType itself resolves category), never the item's own mime — a spoofed or absent
// mime must not let a HEIC file slip into the streamed branch (mediaType.ts independently excludes it
// too, defense-in-depth, the same pattern as the SW's own content-type re-validation).
export function needsImageTransform(item: DriveItem): boolean {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return false
	}

	const name = base.data.decryptedMeta?.name

	return name !== undefined && HEIC_EXTENSIONS.has(extensionOf(name))
}

// Gate for opening a preview: a file, decryptable, resolves to a real category, and — for a
// whole-buffer-only category — under the memory cap (a streamed category is never capped here, except
// HEIC/HEIF: needsImageTransform pulls those back under the cap despite being category "image"). Trash
// is NOT excluded — a trashed file still previews, read-only, mirroring mobile — `variant` is threaded
// for a later trash-exclusion/editability override, not consulted by this base gate.
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

	if (STREAMED_CATEGORIES.has(category) && !needsImageTransform(item)) {
		return true
	}

	return base.data.size <= PREVIEW_MAX_BYTES
}

// Decision for a streamed viewer's POST-resolution failure (network drop mid-seek, an SW-side decrypt
// abort, a lifecycle hiccup) — distinct from a registration failure, which always retries buffered
// (StreamedMedia/StreamedImage's own onFallback effect). That retry re-downloads the WHOLE file into
// memory (usePreviewBytes), and a streamed category is never capped at the open gate above — safe for
// the common case, but retrying at arbitrary size is exactly the tab-crashing allocation
// PREVIEW_MAX_BYTES exists to avoid elsewhere. "error" keeps the item on a labeled error state instead
// of ever attempting that download; ExtraData's `size` is present on every DriveItem arm (synthetic
// 0n for a directory), so no file-arm narrow is needed here.
export function streamFailureAction(item: DriveItem): "buffer" | "error" {
	return asDirectoryOrFile(item).data.size <= PREVIEW_MAX_BYTES ? "buffer" : "error"
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

// Non-fatal UTF-8 decode — an invalid byte sequence becomes the U+FFFD replacement character rather
// than throwing (TextDecoder's default `fatal: false`). A whole-buffer text/code/markdown preview
// always renders SOMETHING: a labeled "can't display" would be wrong for a file that decodes almost
// entirely cleanly, and a hard failure on the rare genuinely-binary-misnamed file just shows as a
// handful of replacement glyphs instead of blocking the preview outright.
export function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes)
}

// ext -> the language tag textViewer.tsx's own loader switches on to pick a CodeMirror language
// package (lazily imported there — this file stays framework-free, so the map value is a plain string,
// never a CodeMirror Extension). "" means no grammar is wired for that extension; the file still
// renders as a fully usable read-only, unhighlighted CodeMirror view, never a blocked preview. Every
// CODE_EXTENSIONS entry above is covered (some intentionally unmapped — no maintained CodeMirror 6
// grammar exists for a bare Makefile/DOS-batch, and "vue"/"svelte" SFC parsing is out of scope), plus
// the two markdown extensions for the view-source fallback (markdownViewer.tsx delegating to
// TextViewer). Several tags share one CodeMirror package family (js/cjs/mjs/jsx/tsx/ts all resolve via
// @codemirror/lang-javascript with different jsx/typescript flags; c/cpp/h/hpp share
// @codemirror/lang-cpp's C-family grammar; cs/kt/dart/gradle route through the legacy clike/groovy
// stream parsers, the closest available grammars for those).
const CODE_LANGUAGE_MAP: Readonly<Record<string, string>> = {
	js: "javascript",
	cjs: "javascript",
	mjs: "javascript",
	jsx: "jsx",
	tsx: "tsx",
	ts: "typescript",
	json: "json",
	htm: "html",
	html: "html",
	html5: "html",
	css: "css",
	css3: "css",
	coffee: "coffeescript",
	litcoffee: "coffeescript",
	sass: "sass",
	xml: "xml",
	sql: "sql",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	py: "python",
	py3: "python",
	cmake: "cmake",
	cs: "csharp",
	dart: "dart",
	dockerfile: "dockerfile",
	go: "go",
	less: "less",
	yaml: "yaml",
	vbs: "vbscript",
	cobol: "cobol",
	toml: "toml",
	conf: "ini",
	ini: "ini",
	gradle: "groovy",
	lua: "lua",
	cpp: "cpp",
	c: "cpp",
	h: "cpp",
	hpp: "cpp",
	rs: "rust",
	sh: "shell",
	rb: "ruby",
	ps1: "powershell",
	protobuf: "protobuf",
	proto: "protobuf",
	php: "php",
	md: "markdown",
	markdown: "markdown"
}

export function codeMirrorLanguageFor(ext: string): string {
	return CODE_LANGUAGE_MAP[ext] ?? ""
}
