import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { clampListboxIndex } from "@/features/drive/lib/listbox"
import { SPREADSHEET_EXTENSIONS } from "@/features/spreadsheet/lib/fileKind"
import { CODE_FILE_EXTENSIONS, effectiveExtension, extensionStart } from "@filen/shared"

// Every previewable file resolves to one of these; "other" is the download-only fallback (no viewer,
// ever — canPreview excludes it unconditionally).
export type PreviewCategory =
	"image" | "rawImage" | "video" | "audio" | "pdf" | "docx" | "spreadsheet" | "text" | "code" | "markdown" | "other"

// Whole-buffer preview memory ceiling (old-web's MAX_PREVIEW_SIZE_WEB precedent): pdf/docx/text/code/
// markdown download fully into RAM before rendering, so an oversize file is excluded from canPreview
// rather than risking a tab-crashing allocation. video/audio/image stream via the service worker's
// inline Range route instead and are never bounded by this — image ALSO keeps a whole-buffer fallback
// (dev / SW absent / stream registration failure) that this cap does not gate either, since the SW's
// own availability isn't known at gating time; an oversize image on that fallback path is an accepted,
// deliberate tradeoff of joining the streamed set, not a regression this cap is meant to catch.
// rawImage is exempt for a different reason again: nothing on the JS side ever holds a RAW file's
// bytes — the SDK reads the ranges it needs itself (an embedded-preview probe first, at worst a
// whole-file stream inside wasm), so a 90 MB NEF costs this heap nothing and has no reason to be
// gated by a JS-memory ceiling.
export const PREVIEW_MAX_BYTES = 268_435_456n // 256 MiB
// A grid holds every cell's view in memory, several times the file's own size (an .xlsx is zipped), so
// spreadsheets stop well below the other whole-buffer previews.
export const SPREADSHEET_MAX_BYTES = 67_108_864n // 64 MiB

// HEIC/HEIF resolve to the "image" category below like every other image extension, but browsers
// cannot decode them inline — needsImageTransform/canPreview single them out to route through the
// buffered download + a client-side transform (features/preview/lib/heicTransform.ts) instead of the SW's
// streamed route every other image extension uses. "hif" is Fujifilm's extension for the same container,
// written 10-bit 4:2:2; libheif decodes high-bit-depth HEVC and hands back 8-bit RGBA like any other HEIC.
export const HEIC_EXTENSIONS = new Set(["heic", "heif", "hif"])
// The camera-RAW families the Rust SDK's own decoder recognizes, listed here so this app's category
// map, icon routing and photos predicate agree with what `canMakeThumbnail` will actually say for
// them. Their own category ("rawImage") rather than "image": no browser decodes a RAW container, so
// every browser-owned image path (the SW's inline Range route, <img>, createImageBitmap) is wrong for
// them — only the SDK can turn one into pixels.
export const RAW_IMAGE_EXTENSIONS = new Set([
	"3fr",
	"arw",
	"cr2",
	"cr3",
	"dng",
	"erf",
	"iiq",
	"kdc",
	"mos",
	"mrw",
	"nef",
	"nrw",
	"orf",
	"pef",
	"raf",
	"raw",
	"rw2",
	"rwl",
	"srf",
	"srw",
	"x3f"
])
function buildExtensionCategories(entries: [Iterable<string>, PreviewCategory][]): ReadonlyMap<string, PreviewCategory> {
	const map = new Map<string, PreviewCategory>()

	for (const [extensions, category] of entries) {
		for (const ext of extensions) {
			if (!map.has(ext)) {
				map.set(ext, category)
			}
		}
	}

	return map
}

// The single extension -> category table (icon.logic routes through it too, so a file's type icon and
// its preview category can never disagree). First listing wins; image/heic come BEFORE rawImage on
// purpose: the sets are disjoint today, but if a RAW family ever gained a browser-decodable sibling
// extension the browser-decodable answer must win — "image" renders the full picture, "rawImage" only
// the camera's embedded preview.
const EXTENSION_CATEGORIES: ReadonlyMap<string, PreviewCategory> = buildExtensionCategories([
	[["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "apng", "avif"], "image"],
	[HEIC_EXTENSIONS, "image"],
	[RAW_IMAGE_EXTENSIONS, "rawImage"],
	[["mp4", "webm", "mkv", "mov", "m4v"], "video"],
	[["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"], "audio"],
	[["pdf"], "pdf"],
	[["docx"], "docx"],
	[SPREADSHEET_EXTENSIONS, "spreadsheet"],
	[["md", "markdown"], "markdown"],
	[["txt", "log"], "text"],
	[CODE_FILE_EXTENSIONS, "code"]
])

// Lowercased extension with no leading dot; "" when the name has none (including a dotfile like
// ".gitignore", where the only "." is the leading one — not a real extension). The name's own extension,
// for what the name itself promises (a spreadsheet's save format); a file's TYPE reads fileTypeExtension.
export function extensionOf(name: string): string {
	const dot = extensionStart(name)

	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
}

export function previewCategoryForExtension(ext: string): PreviewCategory | null {
	return EXTENSION_CATEGORIES.get(ext) ?? null
}

function isKnownExtension(ext: string): boolean {
	return EXTENSION_CATEGORIES.has(ext)
}

// The extension a file's type is read from (@filen/shared's effectiveExtension): its own when the table
// above knows it, else a well-known name's (LICENSE, Makefile, .gitignore), else its stored mime's. Icon,
// preview category, HEIC routing, thumbnails and the editor language all key on this, so they agree.
export function fileTypeExtension(name: string, mime: string | null | undefined): string {
	return effectiveExtension(name, mime, isKnownExtension)
}

// fileTypeExtension for a drive item; "" for a directory or an undecryptable file.
export function itemTypeExtension(item: DriveItem): string {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.decryptedMeta === null) {
		return ""
	}

	return fileTypeExtension(base.data.decryptedMeta.name, base.data.decryptedMeta.mime)
}

// A directory (or a shared-directory arm, which asDirectoryOrFile normalizes to one) always resolves
// "other" — there is nothing to preview.
export function previewType(item: DriveItem): PreviewCategory {
	return previewCategoryForExtension(itemTypeExtension(item)) ?? "other"
}

// image joins video/audio here: all three prefer the SW's inline Range route
// (features/preview/lib/previewStream.ts) and fall whole-buffer only as a capability fallback (dev / SW absent / registration
// failure) — see PREVIEW_MAX_BYTES's own comment on the tradeoff that fallback accepts. HEIC/HEIF are
// the one "image" exception: needsImageTransform below excludes them from ever attempting the
// streamed route at all — canPreview applies the whole-buffer cap to them instead, same as pdf/docx.
// rawImage is deliberately NOT a member: no browser decodes a RAW container, so handing one to the
// SW's inline route would serve bytes nothing can render (mediaType.ts refuses it independently).
const STREAMED_CATEGORIES = ["video", "audio", "image"] as const satisfies readonly PreviewCategory[]
const STREAMED_CATEGORY_SET: ReadonlySet<PreviewCategory> = new Set(STREAMED_CATEGORIES)

export type StreamedCategory = (typeof STREAMED_CATEGORIES)[number]

export function isStreamedCategory(category: PreviewCategory): category is StreamedCategory {
	return STREAMED_CATEGORY_SET.has(category)
}

// True for HEIC/HEIF — an "image"-category item that still can't stream, since no browser decodes it
// inline. imageViewer.tsx checks this before ever considering the SW route, routing these through the
// buffered download + a client-side transform (features/preview/lib/heicTransform.ts) instead. Keyed on
// the same type extension as previewType, so a HEIC-named file always routes here whatever its mime says
// (mediaType.ts independently excludes it from the streamed route too, defense-in-depth).
export function needsImageTransform(item: DriveItem): boolean {
	return HEIC_EXTENSIONS.has(itemTypeExtension(item))
}

// Gate for opening a preview: a file, decryptable, resolves to a real category, and — for a
// whole-buffer-only category — under the memory cap (a streamed category is never capped here, except
// HEIC/HEIF: needsImageTransform pulls those back under the cap despite being category "image"). Trash
// is NOT excluded — a trashed file still previews, read-only, mirroring mobile.
export function canPreview(item: DriveItem): boolean {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return false
	}

	const category = previewType(item)

	if (category === "other") {
		return false
	}

	if (isStreamedCategory(category) && !needsImageTransform(item)) {
		return true
	}

	const cap = bufferedSizeCap(category)

	return cap === null || base.data.size <= cap
}

// "Open as text": a file nothing recognises, small enough to load whole, may still be text (a config file
// under an unknown extension). Its viewer is read-only: saving a binary file back as text would corrupt it.
export function canOpenAsText(item: DriveItem): boolean {
	const base = asDirectoryOrFile(item)

	return base.type === "file" && !base.data.undecryptable && previewType(item) === "other" && base.data.size <= PREVIEW_MAX_BYTES
}

// The JS-memory ceiling for a category previewed from a whole buffer. null for rawImage: it is not
// streamed to the page at all — the SDK reads whatever ranges it needs inside wasm and hands back only
// a small decoded result, so the file never enters JS memory and there is nothing to protect.
export function bufferedSizeCap(category: PreviewCategory): bigint | null {
	if (category === "rawImage") {
		return null
	}

	return category === "spreadsheet" ? SPREADSHEET_MAX_BYTES : PREVIEW_MAX_BYTES
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

// The pager's candidate list — every previewable item in a listing EXCEPT audio, in the listing's own
// sorted order (no re-sort of its own; the caller's array is already in display order). Audio is
// deliberately excluded: a drive-hosted audio file hands off to the persistent player instead of the
// preview overlay (see directoryListing's open handler), so the overlay never renders or pages to it —
// stepping through a mixed folder skips audio and the pager's count reflects that. The public-link page
// keeps its own audio surface, which does not route through this helper.
export function previewableSiblings(items: DriveItem[]): DriveItem[] {
	return items.filter(item => canPreview(item) && previewType(item) !== "audio")
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

// A NUL byte near the start marks a binary file (text never contains one): a file opened as text that
// isn't shows a notice instead of a screen of replacement glyphs.
const BINARY_PROBE_BYTES = 8192

export function looksBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

// ext -> the language tag codeMirrorShared.ts maps to a CodeMirror language package (this file stays
// framework-free, so the map value is a plain string, never a CodeMirror Extension). "" means no
// grammar is wired for that extension; the file still renders as a fully usable read-only,
// unhighlighted CodeMirror view, never a blocked preview. Every
// CODE_FILE_EXTENSIONS entry is covered (some intentionally unmapped — no maintained CodeMirror 6
// grammar exists for a bare Makefile/DOS-batch, and "vue"/"svelte" SFC parsing is out of scope), plus
// the two markdown extensions for markdownViewer.tsx's view-source editor. Several tags share one
// CodeMirror package family (js/cjs/mjs/jsx/tsx/ts all resolve via
// @codemirror/lang-javascript with different jsx/typescript flags; c/cpp/h/hpp share
// @codemirror/lang-cpp's C-family grammar; cs/kt/dart/gradle route through the legacy clike/groovy
// stream parsers, the closest available grammars for those).
const CODE_LANGUAGE_MAP = {
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
} as const satisfies Readonly<Record<string, string>>

export type CodeMirrorTag = (typeof CODE_LANGUAGE_MAP)[keyof typeof CODE_LANGUAGE_MAP]

export function codeMirrorLanguageFor(ext: string): CodeMirrorTag | "" {
	const byExt: Readonly<Partial<Record<string, CodeMirrorTag>>> = CODE_LANGUAGE_MAP
	return byExt[ext] ?? ""
}

// Every extension codeMirrorLanguageFor recognizes — the notes import feature builds its file input's
// `accept` union from this list, so a future CODE_LANGUAGE_MAP addition is picked up there automatically
// instead of drifting out of sync with a hand-maintained second list.
export function codeMirrorSupportedExtensions(): readonly string[] {
	return Object.keys(CODE_LANGUAGE_MAP)
}
