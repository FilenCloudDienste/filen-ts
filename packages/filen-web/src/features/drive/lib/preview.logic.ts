import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { clampListboxIndex } from "@/features/drive/lib/listbox"
import { ARCHIVE_NAME_EXTENSIONS } from "@/features/drive/lib/archiveFormats"
import { SPREADSHEET_EXTENSIONS } from "@/features/spreadsheet/lib/fileKind"
import { PRESENTATION_EXTENSIONS } from "@/features/presentation/lib/fileKind"
import { CODE_FILE_EXTENSIONS, extensionStart, resolveFileKind, type FileVerdict, type FileKind } from "@filen/shared"
import { codeLanguageExtensions, codeLanguageForExtension, type CodeLanguageId } from "@filen/office/core/code"
import { fileKindVerdict } from "@/features/drive/lib/fileKindVerdicts"

// Every previewable file resolves to one of these; "other" is the download-only fallback (no viewer,
// ever — canPreview excludes it unconditionally).
export type PreviewCategory =
	| "image"
	| "rawImage"
	| "video"
	| "audio"
	| "pdf"
	| "docx"
	| "spreadsheet"
	| "presentation"
	| "text"
	| "code"
	| "markdown"
	| "archive"
	| "other"

// Whole-buffer preview memory ceiling (old-web's MAX_PREVIEW_SIZE_WEB precedent): pdf/docx (and text,
// under its own lower cap below) download fully into RAM before rendering, so an oversize file is excluded from canPreview
// rather than risking a tab-crashing allocation. video/audio/image stream via the service worker's
// inline Range route instead and are never bounded by this; video and audio fall back to MediaSource fed
// by the remux worker (never a whole buffer) — image ALSO keeps a whole-buffer fallback
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
// Text viewers hold the file as a string (UTF-16, twice its bytes) plus the editor's own document model,
// and real text files are far smaller, so text, code, markdown and open-as-text stop lower still.
export const TEXT_MAX_BYTES = 33_554_432n // 32 MiB

const TEXT_CATEGORIES: ReadonlySet<PreviewCategory> = new Set(["text", "code", "markdown"])

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
	// MKV and transport streams play through the remux worker. A `.ts`/`.mts` reads as one only once a read
	// of its content said so (resolveFileKind hands such a file over as "m2ts").
	[["mp4", "webm", "mkv", "mov", "m4v", "m2ts"], "video"],
	// AIFF and CAF play natively in Safari (through the service worker's route); elsewhere they fail.
	// Matroska audio and bare AC-3, E-AC-3 and DTS streams play decoded in the remux worker.
	[
		["mp3", "m4a", "m4b", "aac", "wav", "ogg", "oga", "weba", "flac", "opus", "aiff", "aif", "caf", "mka", "ac3", "eac3", "ec3", "dts"],
		"audio"
	],
	[["pdf"], "pdf"],
	// Macro-enabled documents and templates open (and edit) as documents; macros are never run. Word 97–2003 documents
	// and templates open from their conversion, view-only; OpenDocument text (and its templates) translated, editable.
	[["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "ott", "rtf"], "docx"],
	[SPREADSHEET_EXTENSIONS, "spreadsheet"],
	// Decks, templates and shows, macro-enabled or not (macros never run), OpenDocument presentations, and PowerPoint
	// 97–2003 files (viewed). A `.pot` is a 97–2003 template until a read of its signature says it is text (gettext).
	[PRESENTATION_EXTENSIONS, "presentation"],
	[["md", "markdown"], "markdown"],
	[["txt", "log"], "text"],
	[ARCHIVE_NAME_EXTENSIONS, "archive"],
	[CODE_FILE_EXTENSIONS, "code"],
	// TypeScript ES-module and CommonJS sources.
	[["mts", "cts"], "code"]
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

// The extension a file's type is read from (@filen/shared's resolveFileKind): its own when the table above
// knows it and it means one thing, else a content verdict for the file (by `uuid`) or a MIME type for an
// extension that means two, else a specific MIME type, a well-known name (LICENSE, Makefile, .gitignore)
// or a generic MIME type. Icon, preview category, HEIC routing, thumbnails and the editor language all key
// on this, so they agree.
//
// `verdict`, here and below: the file's verdict as a component holds it (useFileKindVerdict), so what it
// computes from it follows a change; the store's when absent, which is the same value. Null resolves
// without one (the SDK worker, which holds no verdicts).
export function fileTypeExtension(name: string, mime: string | null | undefined, uuid?: string, verdict?: FileVerdict | null): string {
	return resolveFileKind(
		{ name, mime, verdict: verdict === undefined ? (uuid === undefined ? null : fileKindVerdict(uuid)) : verdict },
		previewCategoryForExtension
	).extension
}

// The extension a drive item's type reads from, content verdicts included (itemFileKind); "" for a
// directory or an undecryptable file.
export function itemTypeExtension(item: DriveItem, verdict?: FileVerdict | null): string {
	return itemFileKind(item, verdict)?.extension ?? ""
}

// The file's kind by the shared resolver (resolveFileKind): its extension, a verdict an earlier read of its
// content left (fileKindVerdicts.ts), its stored MIME type, a well-known name. A directory, or a file
// without decrypted metadata, has none.
export function itemFileKind(item: DriveItem, verdict?: FileVerdict | null): FileKind<PreviewCategory> | null {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.decryptedMeta === null) {
		return null
	}

	return resolveFileKind(
		{
			name: base.data.decryptedMeta.name,
			mime: base.data.decryptedMeta.mime,
			size: base.data.size,
			verdict: verdict === undefined ? fileKindVerdict(base.data.uuid) : verdict
		},
		previewCategoryForExtension
	)
}

// A `.ts`/`.mts` the preview has to read before it knows its viewer: TypeScript until a read says it is
// a transport stream, and large enough to be one.
export function unprobedTransportStream(item: DriveItem): boolean {
	const kind = itemFileKind(item)

	return kind !== null && kind.sniffable && (kind.extension === "ts" || kind.extension === "mts")
}

// A `.dot` or `.pot` no read has told apart yet: the docx (presentation) viewer's own read decides whether it is a
// Word (PowerPoint) 97–2003 template or a text file (a Graphviz graph, a gettext template), and records the verdict
// that settles it.
export function unsniffedTemplate(item: DriveItem): boolean {
	const kind = itemFileKind(item)

	return kind !== null && kind.sniffable && (kind.extension === "dot" || kind.extension === "pot")
}

// A directory (or a shared-directory arm, which asDirectoryOrFile normalizes to one) always resolves
// "other" — there is nothing to preview.
export function previewType(item: DriveItem, verdict?: FileVerdict | null): PreviewCategory {
	return itemFileKind(item, verdict)?.kind ?? "other"
}

// image joins video/audio here: all three prefer the SW's inline Range route
// (features/preview/lib/previewStream.ts). Only image falls whole-buffer as a capability fallback (SW absent /
// registration failure) — see PREVIEW_MAX_BYTES's own comment on the tradeoff that fallback accepts; video
// and audio stream through MediaSource instead. HEIC/HEIF are
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

	// Its probe decides the viewer: a transport stream streams at any size.
	if (unprobedTransportStream(item)) {
		return true
	}

	const category = previewType(item)

	if (category === "other") {
		return false
	}

	if (isStreamedCategory(category) && !needsImageTransform(item)) {
		return true
	}

	// A drive deck is read in ranges by the presentation worker (bounded block cache), never whole: any size opens.
	if (category === "presentation") {
		return true
	}

	const cap = bufferedSizeCap(category)

	return cap === null || base.data.size <= cap
}

// "Open as text": a file nothing recognises, small enough to load whole, may still be text (a config file
// under an unknown extension). Its viewer is read-only: saving a binary file back as text would corrupt it.
export function canOpenAsText(item: DriveItem): boolean {
	const base = asDirectoryOrFile(item)

	return base.type === "file" && !base.data.undecryptable && previewType(item) === "other" && base.data.size <= TEXT_MAX_BYTES
}

// The JS-memory ceiling for a category previewed from a whole buffer. null for rawImage: it is not
// streamed to the page at all — the SDK reads whatever ranges it needs inside wasm and hands back only
// a small decoded result, so the file never enters JS memory and there is nothing to protect. null for
// archive too: the SDK lists it in the worker and the page only ever holds the entry list.
export function bufferedSizeCap(category: PreviewCategory): bigint | null {
	if (category === "rawImage" || category === "archive") {
		return null
	}

	if (category === "spreadsheet") {
		return SPREADSHEET_MAX_BYTES
	}

	return TEXT_CATEGORIES.has(category) ? TEXT_MAX_BYTES : PREVIEW_MAX_BYTES
}

// Decision for a streamed image's POST-resolution failure (network drop, an SW-side decrypt abort, a
// lifecycle hiccup) — distinct from a registration failure, which always retries buffered
// (StreamedPreview's own onFallback effect). Video and audio never buffer: they move to MediaSource
// instead (mediaViewer.tsx). That retry re-downloads the WHOLE file into
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

// ext -> the code language (@filen/office/core/code: every grammar both apps ship) codeMirrorShared.ts
// builds the editor's highlighting from. "" means no grammar covers the extension; the file still renders
// as a fully usable, unhighlighted CodeMirror view, never a blocked preview.
export type CodeMirrorTag = CodeLanguageId

export function codeMirrorLanguageFor(ext: string): CodeMirrorTag | "" {
	return codeLanguageForExtension(ext) ?? ""
}

// Every extension codeMirrorLanguageFor recognizes — the notes import feature builds its file input's
// `accept` union from this list, so the language table and that list never drift apart.
export function codeMirrorSupportedExtensions(): readonly string[] {
	return codeLanguageExtensions()
}
