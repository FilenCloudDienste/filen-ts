import { describe, expect, expectTypeOf, it } from "vitest"
import type { EntryAccess, File, UuidStr } from "@filen/sdk-rs"
import { AUDIO_FORMATS } from "@filen/shared"
import { narrowItem, asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import {
	bufferedSizeCap,
	canPreview,
	canPreviewWith,
	CATEGORY_POLICY,
	EXTENSION_TIERS,
	fileTypeExtension,
	isStreamedCategory,
	itemTypeExtension,
	needsImageTransform,
	previewableSiblings,
	previewCategoryForExtension,
	previewType,
	unprobedTransportStream,
	PREVIEW_MAX_BYTES,
	SPREADSHEET_MAX_BYTES,
	TEXT_MAX_BYTES,
	type PreviewCategory,
	type StreamedCategory
} from "@/features/drive/lib/preview.logic"
import { anonPreviewability } from "@/features/publicLinks/lib/download.logic"
import { canOpenEntry } from "@/features/archive/lib/entryAccess.logic"
import { previewKindLabelKey } from "@/features/drive/components/infoDialog.logic"
import { isPhotoCategory } from "@/features/photos/lib/predicate"
import { canEditImage, isTextCategory } from "@/features/drive/lib/previewSave.logic"
import { audioRoute } from "@/lib/media/audioRoute.logic"
import { HEIC_EXTENSIONS, IMAGE_FORMATS, streamsNatively } from "@/features/preview/lib/imageFormat"
import { capFor, deviceProfile, type DeviceProfile } from "@/lib/deviceProfile"
import { storeOf } from "@/tests/support/archiveEntries"
import { testUuid } from "@/tests/support/uuid"

// The policy table must reproduce the gates it replaced, row by row. The functions below are the gates as they were
// before the table, kept verbatim as the reference.

const MIB = 1024n * 1024n

const LEGACY_TEXT: ReadonlySet<PreviewCategory> = new Set(["text", "code", "markdown"])
const LEGACY_STREAMED: ReadonlySet<PreviewCategory> = new Set(["video", "audio", "image"])
const LEGACY_HEIC = new Set(["heic", "heif", "hif"])
const LEGACY_ENTRY: ReadonlySet<PreviewCategory> = new Set([
	"text",
	"code",
	"markdown",
	"pdf",
	"docx",
	"spreadsheet",
	"presentation",
	"image"
])
const LEGACY_KIND: Record<string, ReadonlySet<PreviewCategory>> = {
	image: new Set(["image", "rawImage"]),
	video: new Set(["video"]),
	audio: new Set(["audio"]),
	document: new Set(["pdf", "docx", "spreadsheet", "text", "markdown"])
}
const LEGACY_LABELS: Record<PreviewCategory, string | null> = {
	image: "drivePreviewKindImage",
	rawImage: "drivePreviewKindRawImage",
	video: "drivePreviewKindVideo",
	audio: "drivePreviewKindAudio",
	pdf: "drivePreviewKindPdf",
	docx: "drivePreviewKindDocx",
	spreadsheet: "drivePreviewKindSpreadsheet",
	presentation: "drivePreviewKindPresentation",
	text: "drivePreviewKindText",
	code: "drivePreviewKindCode",
	markdown: "drivePreviewKindMarkdown",
	archive: "drivePreviewKindArchive",
	other: null
}
const LEGACY_TRANSCODED = new Set(["mka", "ac3", "eac3", "ec3", "dts"])
const LEGACY_IMAGE_TIER = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "apng", "avif", "heic", "heif", "hif"]
const LEGACY_AUDIO_TIER = [
	"mp3",
	"m4a",
	"m4b",
	"aac",
	"wav",
	"ogg",
	"oga",
	"weba",
	"flac",
	"opus",
	"aiff",
	"aif",
	"caf",
	"mka",
	"ac3",
	"eac3",
	"ec3",
	"dts"
]

function legacyBufferedSizeCap(category: PreviewCategory): bigint | null {
	if (category === "rawImage" || category === "archive") {
		return null
	}

	if (category === "spreadsheet") {
		return SPREADSHEET_MAX_BYTES
	}

	return LEGACY_TEXT.has(category) ? TEXT_MAX_BYTES : PREVIEW_MAX_BYTES
}

function legacyNeedsImageTransform(item: DriveItem): boolean {
	return LEGACY_HEIC.has(itemTypeExtension(item))
}

function legacyCanPreview(item: DriveItem): boolean {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return false
	}

	if (unprobedTransportStream(item)) {
		return true
	}

	const category = previewType(item)

	if (category === "other") {
		return false
	}

	if (LEGACY_STREAMED.has(category) && !legacyNeedsImageTransform(item)) {
		return true
	}

	if (category === "presentation") {
		return true
	}

	const cap = legacyBufferedSizeCap(category)

	return cap === null || base.data.size <= cap
}

function legacyAnon(item: DriveItem): string {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return "unpreviewable"
	}

	if (unprobedTransportStream(item)) {
		return "previewable"
	}

	const category = previewType(item)

	if (category === "other") {
		return "unpreviewable"
	}

	if (category === "archive") {
		return "archive"
	}

	if (category === "video" || category === "audio") {
		return "previewable"
	}

	const cap = legacyBufferedSizeCap(category)

	return cap === null || base.data.size <= cap ? "previewable" : "too-large"
}

function legacyCanOpenEntry(name: string, size: number): boolean {
	const category = previewCategoryForExtension(fileTypeExtension(name, null))
	const cap = category === null || !LEGACY_ENTRY.has(category) ? null : legacyBufferedSizeCap(category)

	return cap !== null && size <= Number(cap)
}

function fileNamed(name: string, size: bigint, mime = "application/octet-stream"): DriveItem {
	const uuid: UuidStr = testUuid(`${name}:${String(size)}`)
	const file: File = {
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size, key: "key", version: 2 } }
	}

	return narrowItem(file)
}

// One name per category, plus the rows that take another path through the gates (HEIC, SVG, decoded audio, a CSV, a
// probed transport stream, a template).
const NAMES = [
	"photo.jpg",
	"logo.svg",
	"photo.heic",
	"DSCF0001.HIF",
	"shot.nef",
	"movie.mp4",
	"film.mkv",
	"clip.ts",
	"song.mp3",
	"film.mka",
	"doc.pdf",
	"report.docx",
	"memo.dot",
	"book.xlsx",
	"table.csv",
	"deck.pptx",
	"deck.pot",
	"notes.txt",
	"script.js",
	"readme.md",
	"bundle.zip",
	"setup.exe"
]
const CAPS = [TEXT_MAX_BYTES, SPREADSHEET_MAX_BYTES, PREVIEW_MAX_BYTES]
const SIZES = [0n, ...CAPS.flatMap(cap => [cap - 1n, cap, cap + 1n]), 50n * 1024n * MIB]
const CATEGORIES = Object.keys(CATEGORY_POLICY) as PreviewCategory[]
const DIRECT: EntryAccess = { type: "direct", packedBytes: 10n }

describe("CATEGORY_POLICY reproduces the gates it replaced", () => {
	it.each(NAMES)("%s: canPreview and anonPreviewability at every size boundary", name => {
		for (const size of SIZES) {
			const item = fileNamed(name, size)

			expect(canPreview(item), `${name} @ ${String(size)}`).toBe(legacyCanPreview(item))
			expect(anonPreviewability(item), `${name} @ ${String(size)}`).toBe(legacyAnon(item))
		}
	})

	it.each(NAMES)("%s: archive entries open at every size boundary", name => {
		for (const size of SIZES) {
			const entrySize = Number(size)

			expect(canOpenEntry(storeOf([{ path: name, access: DIRECT, size: entrySize }]), 0), `${name} @ ${String(size)}`).toBe(
				legacyCanOpenEntry(name, entrySize)
			)
		}
	})

	it("keeps HEIC routing by the type extension", () => {
		for (const name of NAMES) {
			const item = fileNamed(name, 1024n)

			expect(needsImageTransform(item), name).toBe(legacyNeedsImageTransform(item))
		}

		expect(needsImageTransform(fileNamed("IMG_0001", 1024n, "image/heic"))).toBe(true)
		expect(needsImageTransform(fileNamed("photo.jpg", 1024n, "image/heic"))).toBe(false)
	})

	it.each(CATEGORIES)("%s: every per-category answer", category => {
		const policy = CATEGORY_POLICY[category]

		// "other" never reached the old cap (every gate refused it first); its row says what it is: none.
		expect(bufferedSizeCap(category, deviceProfile())).toBe(category === "other" ? null : legacyBufferedSizeCap(category))
		expect(isStreamedCategory(category)).toBe(LEGACY_STREAMED.has(category))
		expect(isTextCategory(category)).toBe(LEGACY_TEXT.has(category))
		expect(policy.textFamily).toBe(LEGACY_TEXT.has(category))
		expect(isPhotoCategory(category)).toBe(category === "image" || category === "rawImage" || category === "video")
		expect(previewKindLabelKey(category)).toBe(LEGACY_LABELS[category])
		expect(policy.entry !== "none").toBe(LEGACY_ENTRY.has(category))
		expect(policy.pager).toBe(category !== "audio" && category !== "other")
		expect(policy.aboveCap).toBe("refuse")

		for (const [kind, categories] of Object.entries(LEGACY_KIND)) {
			expect(policy.assistantKind === kind, `${category} as ${kind}`).toBe(categories.has(category))
		}
	})

	it("pages every previewable item but audio, as before", () => {
		const items = NAMES.flatMap(name => SIZES.map(size => fileNamed(name, size)))
		const legacy = items.filter(item => legacyCanPreview(item) && previewType(item) !== "audio")

		expect(previewableSiblings(items)).toEqual(legacy)
	})

	it("derives the streamed categories from the table", () => {
		expectTypeOf<StreamedCategory>().toEqualTypeOf<"image" | "video" | "audio">()
	})

	it("keeps the image and audio tiers, now read from IMAGE_FORMATS and AUDIO_FORMATS", () => {
		expect([...IMAGE_FORMATS.keys()]).toEqual(LEGACY_IMAGE_TIER)
		expect([...AUDIO_FORMATS.keys()]).toEqual(LEGACY_AUDIO_TIER)
		expect([...HEIC_EXTENSIONS]).toEqual([...LEGACY_HEIC])

		for (const extension of LEGACY_AUDIO_TIER) {
			expect(previewCategoryForExtension(extension)).toBe("audio")
		}
	})

	it("transcodes exactly the audio it transcoded before", () => {
		for (const extension of LEGACY_AUDIO_TIER) {
			expect(audioRoute({ extension, contentType: "audio/x", demoted: false }), extension).toBe(
				LEGACY_TRANSCODED.has(extension) ? "transcode" : "direct"
			)
		}
	})

	it("offers the image editor for every image but SVG", () => {
		for (const extension of LEGACY_IMAGE_TIER) {
			expect(canEditImage(fileNamed(`photo.${extension}`, 1024n), "drive"), extension).toBe(extension !== "svg")
		}

		expect(canEditImage(fileNamed("IMG_0001", 1024n, "image/svg+xml"), "drive")).toBe(false)
	})
})

describe("precedence tiers", () => {
	// Every extension listed in more than one tier, and the tier that wins it: none today.
	it("resolves each overlap to the first tier listing it", () => {
		const seen = new Map<string, PreviewCategory>()
		const overlaps: Record<string, PreviewCategory> = {}

		for (const [extensions, category] of EXTENSION_TIERS) {
			for (const extension of extensions) {
				const winner = seen.get(extension)

				if (winner === undefined) {
					seen.set(extension, category)
				} else {
					overlaps[extension] = winner
				}
			}
		}

		expect(overlaps).toEqual({})

		for (const [extension, winner] of Object.entries(overlaps)) {
			expect(previewCategoryForExtension(extension)).toBe(winner)
		}
	})

	it("can be iterated more than once", () => {
		const first = EXTENSION_TIERS.map(([extensions]) => [...extensions].length)

		expect(EXTENSION_TIERS.map(([extensions]) => [...extensions].length)).toEqual(first)
	})
})

describe("profile caps", () => {
	const base = deviceProfile()
	const native: DeviceProfile = { ...base, heicNative: "yes" }
	const notNative: DeviceProfile = { ...base, heicNative: "no" }

	it("evaluates a cap that is a function of the profile", () => {
		const cap = (profile: DeviceProfile) => (profile.mobile ? 64n * MIB : 256n * MIB)

		expect(capFor(cap, { ...base, mobile: true })).toBe(64n * MIB)
		expect(capFor(cap, { ...base, mobile: false })).toBe(256n * MIB)
		expect(capFor(null, base)).toBeNull()
		expect(capFor(32n, base)).toBe(32n)
	})

	it("streams HEIC natively only where the profile says the browser decodes it", () => {
		const heic = IMAGE_FORMATS.get("heic")

		expect(heic).toBeDefined()

		if (heic === undefined) {
			return
		}

		expect(streamsNatively(heic, native)).toBe(true)
		expect(streamsNatively(heic, notNative)).toBe(false)
		expect(streamsNatively(heic, base)).toBe(false)
	})

	it("admits a 300 MiB HEIC uncapped where it streams natively, and refuses it elsewhere", () => {
		const big = fileNamed("photo.heic", 300n * MIB)

		expect(canPreviewWith(big, native)).toBe(true)
		expect(canPreviewWith(big, notNative)).toBe(false)
		expect(needsImageTransform(big, native)).toBe(false)
		expect(needsImageTransform(big, notNative)).toBe(true)
	})
})
