import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { clampListboxIndex } from "@/features/drive/lib/listbox"
import { ARCHIVE_NAME_EXTENSIONS } from "@/features/drive/lib/archiveFormats"
import { SPREADSHEET_EXTENSIONS } from "@/features/spreadsheet/lib/fileKind"
import { PRESENTATION_EXTENSIONS } from "@/features/presentation/lib/fileKind"
import { IWORK_EXTENSIONS } from "@/features/iwork/lib/iworkPreview.logic"
import {
	AUDIO_FORMATS,
	CODE_FILE_EXTENSIONS,
	SUBTITLE_FILE_EXTENSIONS,
	ZIP_PACKAGE_EXTENSIONS,
	extensionStart,
	resolveFileKind,
	sniffCandidates,
	sniffForExtension,
	type FileVerdict,
	type FileKind,
	type SniffId
} from "@filen/shared"
import { codeLanguageExtensions, codeLanguageForExtension, type CodeLanguageId } from "@filen/office/core/code"
import { fileKindVerdict } from "@/features/drive/lib/fileKindVerdicts"
import { HEIC_EXTENSIONS, IMAGE_FORMATS, pendingProbe, streamsNatively } from "@/features/preview/lib/imageFormat"
import type { NativeImageFormat } from "@/lib/nativeImageSupport"
import { EXTENSIONLESS_SNIFF, type ExtensionlessSniff } from "@/features/preview/lib/contentSniff.logic"
import { capFor, deviceProfile, type DeviceProfile, type ProfileCap } from "@/lib/deviceProfile"
import type { DriveKey } from "@/lib/i18n"

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
	| "ebook"
	| "text"
	| "code"
	| "markdown"
	| "archive"
	| "iwork"
	| "font"
	| "sqlite"
	| "other"

// Whole-buffer preview memory ceiling (old-web's MAX_PREVIEW_SIZE_WEB precedent): a file previewed from a whole buffer
// downloads fully into RAM before rendering, so an oversize one is refused rather than risking a tab-crashing allocation.
// Which categories it bounds is CATEGORY_POLICY's.
export const PREVIEW_MAX_BYTES = 268_435_456n // 256 MiB
// A grid holds every cell's view in memory, several times the file's own size (an .xlsx is zipped), so
// spreadsheets stop well below the other whole-buffer previews.
export const SPREADSHEET_MAX_BYTES = 67_108_864n // 64 MiB
// Text viewers hold the file as a string (UTF-16, twice its bytes) plus the editor's own document model,
// and real text files are far smaller, so text, code, markdown and open-as-text stop lower still.
export const TEXT_MAX_BYTES = 33_554_432n // 32 MiB
// A font is held whole twice (the cache for its FontFace, the face's own copy); real ones stay far below.
export const FONT_MAX_BYTES = 67_108_864n // 64 MiB
// An e-book is read through ranges, but MuPDF keeps the parsed book (and a MOBI or FB2 whole) in its heap, which on a
// phone is a quarter of a desktop's: the same bound as the other documents MuPDF reads whole there.
export const EBOOK_MAX_BYTES_MOBILE = 67_108_864n // 64 MiB

export function ebookMaxBytes(profile: DeviceProfile): bigint {
	return profile.mobile ? EBOOK_MAX_BYTES_MOBILE : PREVIEW_MAX_BYTES
}

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
function buildExtensionCategories(
	entries: readonly (readonly [Iterable<string>, PreviewCategory])[]
): ReadonlyMap<string, PreviewCategory> {
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

// How each category previews: one row per category, which every gate, label and set below reads.
export interface CategoryPolicy {
	// Streams through the service worker's inline route at open.
	streamed: boolean
	// The viewer reads ranges, so any drive size opens, up to `rangedMax`.
	ranged: boolean
	// Largest file the viewer reads in ranges; absent for no limit.
	rangedMax?: ProfileCap
	// Largest file held whole in memory (a fallback, a public link, an archive entry); null for none.
	bufferCap: ProfileCap
	// What opens above the cap.
	aboveCap: "refuse" | "largeText"
	// How an archive entry opens.
	entry: "whole" | "ranged" | "none"
	// How a public link previews it.
	anon: "stream" | "ranged" | "archive" | "buffer" | "none"
	// Viewed as a decoded string.
	textFamily: boolean
	// Saved back through the text path.
	editsAsText: boolean
	// Shown in Photos.
	photo: boolean
	// The preview pager steps onto it.
	pager: boolean
	// The info dialog's "Kind" value.
	labelKey: DriveKey | null
	// The assistant's file kind.
	assistantKind: "image" | "video" | "audio" | "document" | null
}

// Media and images stream at any size, on the drive and on a public link. An image keeps a whole-buffer fallback (no
// service worker, a failed registration, no type the inline route may serve it as) only up to its cap: above it the
// viewer waits for a service worker or says the file is too large (StreamablePreview); video and audio fall back to
// MediaSource fed by the remux worker, never a whole buffer. A RAW is never in JS memory (the SDK reads the
// ranges it needs inside wasm), nor is an archive (the SDK lists it in the worker), so neither has a cap; a deck is read
// in ranges by the presentation worker, and a PDF by pdf.js up to the device's ranged ceiling (pdfLimits.ts), on the
// drive and on a public link alike. HEIC/HEIF are "image" but stream only where the browser decodes them
// (streamsNatively); elsewhere the image cap applies.
export const CATEGORY_POLICY = {
	image: {
		streamed: true,
		ranged: false,
		bufferCap: PREVIEW_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "stream",
		textFamily: false,
		editsAsText: false,
		photo: true,
		pager: true,
		labelKey: "drivePreviewKindImage",
		assistantKind: "image"
	},
	rawImage: {
		streamed: false,
		ranged: true,
		bufferCap: null,
		aboveCap: "refuse",
		entry: "none",
		anon: "ranged",
		textFamily: false,
		editsAsText: false,
		photo: true,
		pager: true,
		labelKey: "drivePreviewKindRawImage",
		assistantKind: "image"
	},
	video: {
		streamed: true,
		ranged: false,
		bufferCap: PREVIEW_MAX_BYTES,
		aboveCap: "refuse",
		entry: "none",
		anon: "stream",
		textFamily: false,
		editsAsText: false,
		photo: true,
		pager: true,
		labelKey: "drivePreviewKindVideo",
		assistantKind: "video"
	},
	// A drive audio file hands off to the persistent player, so the pager skips it.
	audio: {
		streamed: true,
		ranged: false,
		bufferCap: PREVIEW_MAX_BYTES,
		aboveCap: "refuse",
		entry: "none",
		anon: "stream",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: false,
		labelKey: "drivePreviewKindAudio",
		assistantKind: "audio"
	},
	pdf: {
		streamed: false,
		ranged: true,
		rangedMax: profile => profile.pdfRangedMax,
		bufferCap: PREVIEW_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "ranged",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindPdf",
		assistantKind: "document"
	},
	docx: {
		streamed: false,
		ranged: false,
		bufferCap: PREVIEW_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "buffer",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindDocx",
		assistantKind: "document"
	},
	spreadsheet: {
		streamed: false,
		ranged: false,
		bufferCap: SPREADSHEET_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "buffer",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindSpreadsheet",
		assistantKind: "document"
	},
	presentation: {
		streamed: false,
		ranged: true,
		bufferCap: PREVIEW_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "ranged",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindPresentation",
		assistantKind: null
	},
	// Read in ranges on a public link, held in MuPDF's heap all the same: the link's limit is the drive's cap.
	ebook: {
		streamed: false,
		ranged: false,
		rangedMax: ebookMaxBytes,
		bufferCap: ebookMaxBytes,
		aboveCap: "refuse",
		entry: "whole",
		anon: "ranged",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindEbook",
		assistantKind: null
	},
	text: {
		streamed: false,
		ranged: false,
		bufferCap: TEXT_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "buffer",
		textFamily: true,
		editsAsText: true,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindText",
		assistantKind: "document"
	},
	code: {
		streamed: false,
		ranged: false,
		bufferCap: TEXT_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "buffer",
		textFamily: true,
		editsAsText: true,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindCode",
		assistantKind: null
	},
	markdown: {
		streamed: false,
		ranged: false,
		bufferCap: TEXT_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "buffer",
		textFamily: true,
		editsAsText: true,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindMarkdown",
		assistantKind: "document"
	},
	archive: {
		streamed: false,
		ranged: true,
		bufferCap: null,
		aboveCap: "refuse",
		entry: "none",
		anon: "archive",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindArchive",
		assistantKind: null
	},
	// The SDK lists the package and reads the one rendering it carries (iworkPreview.ts), so any size opens. Inside an
	// archive, or on a public link, the package needs an archive reader the SDK does not have yet.
	iwork: {
		streamed: false,
		ranged: true,
		bufferCap: null,
		aboveCap: "refuse",
		entry: "none",
		anon: "none",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindIwork",
		assistantKind: null
	},
	font: {
		streamed: false,
		ranged: false,
		bufferCap: FONT_MAX_BYTES,
		aboveCap: "refuse",
		entry: "whole",
		anon: "buffer",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindFont",
		assistantKind: null
	},
	// Read in ranges through the database viewer's own VFS on the drive and a public link, at any size past the
	// automatic check's 256 MiB; held whole in sqlite's memory up to the cap otherwise (sqliteDatabase.ts).
	sqlite: {
		streamed: false,
		ranged: true,
		bufferCap: PREVIEW_MAX_BYTES,
		aboveCap: "refuse",
		entry: "ranged",
		anon: "ranged",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: true,
		labelKey: "drivePreviewKindSqlite",
		assistantKind: null
	},
	// The download-only fallback: no viewer, ever.
	other: {
		streamed: false,
		ranged: false,
		bufferCap: null,
		aboveCap: "refuse",
		entry: "none",
		anon: "none",
		textFamily: false,
		editsAsText: false,
		photo: false,
		pager: false,
		labelKey: null,
		assistantKind: null
	}
} as const satisfies Record<PreviewCategory, CategoryPolicy>

export type StreamedCategory = {
	[K in PreviewCategory]: (typeof CATEGORY_POLICY)[K]["streamed"] extends true ? K : never
}[PreviewCategory]

// Grammar extensions whose files are mostly binary: they stay "other" (Open as text) rather than open as code.
export const CODE_DERIVATION_EXCLUSIONS: ReadonlySet<string> = new Set([
	// A compiled gettext catalog (its source is a `.po`).
	"mo",
	// An OpenPGP signature, binary unless ASCII-armored (`.asc`).
	"sig",
	// An OpenPGP encrypted message.
	"pgp",
	// A Python pickle.
	"p",
	// A ZX Spectrum snapshot (Z80 assembly sources mostly use .asm).
	"z80"
])

// Text a save must never write back: a message or a mailbox is evidence, kept byte for byte.
export const VIEW_ONLY_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["eml", "mbox"])

// Every extension a grammar highlights (@filen/office/core/code), and the shared code set, some of which have no
// grammar (Makefile, .bat, .ps). An extension an earlier tier lists keeps that tier's category.
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
	...CODE_FILE_EXTENSIONS,
	...codeLanguageExtensions().filter(extension => !CODE_DERIVATION_EXCLUSIONS.has(extension))
])

// The extension -> category tiers, in precedence order: the first tier listing an extension wins. icon.logic routes
// through the same table, so a file's type icon and its preview category never disagree. Images come before rawImage
// on purpose: if a RAW family ever gained a browser-decodable sibling extension, "image" renders the full picture,
// "rawImage" only the camera's embedded preview.
export const EXTENSION_TIERS: readonly (readonly [Iterable<string>, PreviewCategory])[] = [
	[[...IMAGE_FORMATS.keys()], "image"],
	[RAW_IMAGE_EXTENSIONS, "rawImage"],
	// MKV and transport streams play through the remux worker. A `.ts`/`.mts` reads as one only once a read
	// of its content said so (resolveFileKind hands such a file over as "m2ts").
	[["mp4", "webm", "mkv", "mov", "m4v", "m2ts"], "video"],
	[[...AUDIO_FORMATS.keys()], "audio"],
	[["pdf"], "pdf"],
	// Macro-enabled documents and templates open (and edit) as documents; macros are never run. Word 97–2003 documents
	// and templates open from their conversion, view-only; OpenDocument text (and its templates) translated, editable.
	[["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "ott", "rtf"], "docx"],
	[SPREADSHEET_EXTENSIONS, "spreadsheet"],
	// Decks, templates and shows, macro-enabled or not (macros never run), OpenDocument presentations, and PowerPoint
	// 97–2003 files (viewed). A `.pot` is a 97–2003 template until a read of its signature says it is text (gettext).
	[PRESENTATION_EXTENSIONS, "presentation"],
	[["ttf", "otf", "woff", "woff2"], "font"],
	// A `.db` is many programs' data: a database only once a read of its head finds the SQLite header.
	[["sqlite", "sqlite3", "db3", "s3db", "sl3"], "sqlite"],
	// Read by MuPDF, laid out to the view (azw3 and other Kindle formats stay downloads).
	[["epub", "mobi", "fb2"], "ebook"],
	[["md", "markdown", "mkd"], "markdown"],
	// Subtitles, calendars, contacts and e-mail read as plain text until a viewer of their own takes them.
	[["txt", "log", ...SUBTITLE_FILE_EXTENSIONS, "ics", "ifb", "ical", "vcf", "vcard", "eml"], "text"],
	[[...ARCHIVE_NAME_EXTENSIONS, ...ZIP_PACKAGE_EXTENSIONS], "archive"],
	// A `.key` is one only once a read of its head found a zip (resolveFileKind gives it no kind until then).
	[IWORK_EXTENSIONS, "iwork"],
	// A `.vhd` is VHDL until a read of its head finds a Virtual Hard Disk.
	[CODE_EXTENSIONS, "code"]
]

const EXTENSION_CATEGORIES: ReadonlyMap<string, PreviewCategory> = buildExtensionCategories(EXTENSION_TIERS)

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
	return fileTypeKind(name, mime, uuid, verdict).extension
}

// The whole resolution fileTypeExtension reads its extension from: the kind, and whether a read decided it.
export function fileTypeKind(
	name: string,
	mime: string | null | undefined,
	uuid?: string,
	verdict?: FileVerdict | null
): FileKind<PreviewCategory> {
	return resolveFileKind(
		{ name, mime, verdict: verdict === undefined ? (uuid === undefined ? null : fileKindVerdict(uuid)) : verdict },
		previewCategoryForExtension
	)
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

// What a content sniff is decided for: a drive or link file, or an archive's entry (no MIME type, no verdict).
export interface SniffSubject {
	readonly name: string
	readonly mime: string | null
	readonly size: bigint
	// Its verdict; null for none.
	readonly verdict: FileVerdict | null
}

// The content read (contentSniff.logic.ts) a file needs before its viewer is known: one its extension's meanings wait
// on while no verdict or text MIME type settled them (a `.ts` large enough to be a transport stream, a `.dot` or
// `.pot` template), or the extensionless read for a file nothing names. Null when its kind is settled.
export function contentSniffFor(subject: SniffSubject, extensionless: ExtensionlessSniff | null = EXTENSIONLESS_SNIFF): SniffId | null {
	const kind = resolveFileKind(subject, previewCategoryForExtension)

	// Its extension's usual meaning, which a read could still overturn.
	if (kind.sniffable && kind.source === "default") {
		return sniffForExtension(kind.extension)
	}

	if (
		extensionless !== null &&
		kind.kind === null &&
		kind.extension === "" &&
		subject.verdict === null &&
		subject.size <= extensionless.cap
	) {
		return extensionless.id
	}

	return null
}

// A drive or link item's (contentSniffFor), its verdict as itemFileKind reads it. Null for a directory or an
// undecryptable file.
export function needsContentSniff(
	item: DriveItem,
	verdict?: FileVerdict | null,
	extensionless: ExtensionlessSniff | null = EXTENSIONLESS_SNIFF
): SniffId | null {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.decryptedMeta === null) {
		return null
	}

	return contentSniffFor(
		{
			name: base.data.decryptedMeta.name,
			mime: base.data.decryptedMeta.mime,
			size: base.data.size,
			verdict: (verdict === undefined ? fileKindVerdict(base.data.uuid) : verdict) ?? null
		},
		extensionless
	)
}

// Where a file is opened: the drive (and an archive's own preview), a public link's page, an archive's entry.
export type SniffSurface = "drive" | "link" | "entry"

// Whether `category` (by `extension`) opens a file of `size` bytes on the drive: its format's cap, then its category's
// (streamed and ranged ones at any size).
function driveAdmits(category: PreviewCategory, extension: string, size: bigint, profile: DeviceProfile): boolean {
	if (category === "other") {
		return false
	}

	const policy: CategoryPolicy = CATEGORY_POLICY[category]
	const ownCap = formatCap(extension, profile)

	if (ownCap !== null && size > ownCap) {
		return false
	}

	if (policy.streamed) {
		const image = category === "image" ? IMAGE_FORMATS.get(extension) : undefined

		if (category !== "image" || (image !== undefined && streamsNatively(image, profile))) {
			return true
		}
	}

	if (policy.ranged) {
		return rangedFits(policy, size, profile)
	}

	const cap = ownCap ?? bufferedSizeCap(category, profile)

	return cap === null || size <= cap || policy.aboveCap === "largeText"
}

// Whether a file of `size` is within what the category's viewer reads in ranges.
function rangedFits(policy: CategoryPolicy, size: bigint, profile: DeviceProfile): boolean {
	const max = policy.rangedMax === undefined ? null : capFor(policy.rangedMax, profile)

	return max === null || size <= max
}

// A public link's inline preview (anonPreviewability): an archive is browsed apart, never previewed inline.
export function linkAdmits(category: PreviewCategory, size: bigint, profile: DeviceProfile): boolean {
	const policy: CategoryPolicy = CATEGORY_POLICY[category]

	switch (policy.anon) {
		case "none":
		case "archive":
			return false
		case "stream":
			return true
		case "ranged":
			return rangedFits(policy, size, profile)
		case "buffer": {
			const cap = bufferedSizeCap(category, profile)

			return cap === null || size <= cap
		}
	}
}

function surfaceAdmits(surface: SniffSurface, category: PreviewCategory, extension: string, size: bigint, profile: DeviceProfile): boolean {
	switch (surface) {
		case "drive":
			return driveAdmits(category, extension, size, profile)
		case "link":
			return linkAdmits(category, size, profile)
		case "entry": {
			const cap = CATEGORY_POLICY[category].entry === "none" ? null : bufferedSizeCap(category, profile)

			return cap !== null && size <= cap
		}
	}
}

// Whether a file waiting on its content read opens on `surface` at its size: some kind the read may find it to be
// opens there. The extensionless read's cap was its admission.
export function sniffAdmitsFor(subject: SniffSubject, profile: DeviceProfile, surface: SniffSurface): boolean {
	const { extension } = resolveFileKind(subject, previewCategoryForExtension)

	if (extension === "") {
		return true
	}

	return sniffCandidates(extension).some(candidate => {
		const category = candidate === null ? null : previewCategoryForExtension(candidate)

		return candidate !== null && category !== null && surfaceAdmits(surface, category, candidate, subject.size, profile)
	})
}

// sniffAdmitsFor a drive or link item; false for a directory or an undecryptable file.
export function sniffAdmits(item: DriveItem, profile: DeviceProfile, surface: SniffSurface = "drive"): boolean {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.decryptedMeta === null) {
		return false
	}

	return sniffAdmitsFor(
		{ name: base.data.decryptedMeta.name, mime: base.data.decryptedMeta.mime, size: base.data.size, verdict: null },
		profile,
		surface
	)
}

// A directory (or a shared-directory arm, which asDirectoryOrFile normalizes to one) always resolves
// "other" — there is nothing to preview.
export function previewType(item: DriveItem, verdict?: FileVerdict | null): PreviewCategory {
	return itemFileKind(item, verdict)?.kind ?? "other"
}

export function isStreamedCategory(category: PreviewCategory): category is StreamedCategory {
	return CATEGORY_POLICY[category].streamed
}

// An "image"-category item this browser cannot show from the service worker's stream (HEIC/HEIF without a native
// decoder): imageViewer.tsx routes it through the buffered download and a client-side transform
// (features/preview/lib/rasterDecode.ts) instead. Keyed on the same type extension as previewType, so a HEIC-named
// file always routes here whatever its mime says (mediaType.ts refuses it the inline route through this too).
export function needsImageTransform(item: DriveItem, profile: DeviceProfile = deviceProfile()): boolean {
	const format = IMAGE_FORMATS.get(itemTypeExtension(item))

	return format !== undefined && !streamsNatively(format, profile)
}

// A HEIC/HEIF by its name, whatever this browser shows by itself: the image editor always decodes one with libheif.
export function isHeicName(item: DriveItem): boolean {
	return HEIC_EXTENSIONS.has(itemTypeExtension(item))
}

// The probe an image's route waits on (pendingProbe); null once the route is known, and for any other file.
export function pendingImageProbe(item: DriveItem, profile: DeviceProfile): NativeImageFormat | null {
	const format = IMAGE_FORMATS.get(itemTypeExtension(item))

	return format === undefined ? null : pendingProbe(format, profile)
}

// The largest image held whole to decode it ourselves: its format's cap, else the image category's; null for none.
export function heldImageCap(item: DriveItem, profile: DeviceProfile): bigint | null {
	return formatCap(itemTypeExtension(item), profile) ?? bufferedSizeCap("image", profile)
}

// The format's own cap, ahead of its category's: an image or audio row's.
function formatCap(extension: string, profile: DeviceProfile): bigint | null {
	const cap = IMAGE_FORMATS.get(extension)?.cap ?? AUDIO_FORMATS.get(extension)?.cap

	return cap === undefined ? null : capFor(cap, profile)
}

// Gate for opening a preview: a file, decryptable, resolves to a real category, and fits the limits its format and
// category set for this device. A streamed category the browser shows from the stream, and a ranged one, open at any
// size. Trash is NOT excluded — a trashed file still previews, read-only, mirroring mobile.
export function canPreviewWith(item: DriveItem, profile: DeviceProfile): boolean {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return false
	}

	// Its content read picks the viewer: it opens if some kind the read may find does.
	if (needsContentSniff(item) !== null) {
		return sniffAdmits(item, profile)
	}

	const kind = itemFileKind(item)

	if (kind === null) {
		return false
	}

	return kind.kind !== null && driveAdmits(kind.kind, kind.extension, base.data.size, profile)
}

// The gate with this device's current profile.
export function canPreview(item: DriveItem): boolean {
	return canPreviewWith(item, deviceProfile())
}

// "Open as text": a file nothing recognises, small enough to load whole, may still be text (a config file
// under an unknown extension). Its viewer is read-only: saving a binary file back as text would corrupt it.
export function canOpenAsText(item: DriveItem): boolean {
	const base = asDirectoryOrFile(item)

	return base.type === "file" && !base.data.undecryptable && previewType(item) === "other" && base.data.size <= TEXT_MAX_BYTES
}

// The JS-memory ceiling for a category previewed from a whole buffer; null for none (see CATEGORY_POLICY).
export function bufferedSizeCap(category: PreviewCategory, profile: DeviceProfile): bigint | null {
	return capFor(CATEGORY_POLICY[category].bufferCap, profile)
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

// The pager's candidate list — every previewable item in a listing whose category pages (not audio), in the listing's
// own sorted order (no re-sort of its own; the caller's array is already in display order). Audio is
// deliberately excluded: a drive-hosted audio file hands off to the persistent player instead of the
// preview overlay (see directoryListing's open handler), so the overlay never renders or pages to it —
// stepping through a mixed folder skips audio and the pager's count reflects that. The public-link page
// keeps its own audio surface, which does not route through this helper. A file whose content read picks its viewer
// pages before the read ran (an unread `.key` resolves "other"): the overlay's gate reads it.
export function previewableSiblings(items: DriveItem[]): DriveItem[] {
	const profile = deviceProfile()

	return items.filter(
		item => canPreviewWith(item, profile) && (needsContentSniff(item) !== null || CATEGORY_POLICY[previewType(item)].pager)
	)
}

// What opening `item` from a listing hands the overlay: the pager's list, at the item's place in it. A file the pager
// does not hold opens alone, never as its first sibling.
export function previewOpenTarget(items: DriveItem[], item: DriveItem): { siblings: DriveItem[]; index: number } {
	const siblings = previewableSiblings(items)
	const index = siblings.findIndex(sibling => sibling.data.uuid === item.data.uuid)

	return index === -1 ? { siblings: [item], index: 0 } : { siblings, index }
}

// Resolves the sibling one step (no wrap) from whichever sibling currently carries `currentUuid` — a
// uuid lookup rather than a plain index+delta so a caller holding only the current item's identity can
// still step correctly even if its position within `siblings` shifted. An unresolvable uuid steps from
// the start of the list.
export function stepPreviewIndex(currentUuid: string, siblings: DriveItem[], delta: number): number {
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
