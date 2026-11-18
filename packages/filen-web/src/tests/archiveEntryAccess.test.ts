import { describe, expect, it, vi } from "vitest"
import type { AnyFile, EntryAccess } from "@filen/sdk-rs"
import {
	canOpenEntry,
	entryExtractCard,
	canReadEntry,
	entryCost,
	entryKey,
	entryPreviewCategory,
	isEncryptedEntry,
	maxSolidSkipFor,
	needsCostConfirm,
	holdsNestedArchive,
	NESTED_INFLATE_CONFIRM_BYTES,
	nestedOpening,
	sniffedEntryCategory,
	sniffMayReadByRange
} from "@/features/archive/lib/entryAccess.logic"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { driveItemMime, isLinkedEmbedItem } from "@/features/drive/lib/item"
import { ENTRY_RANGE_BUFFER_CAP, previewType, SPREADSHEET_MAX_BYTES, TEXT_MAX_BYTES } from "@/features/drive/lib/preview.logic"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import { storeOf, TEST_ARCHIVE, type EntrySpec } from "@/tests/support/archiveEntries"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: {} }))

const { entryRequest } = await import("@/features/archive/lib/entryDownload")

const DIRECT: EntryAccess = { type: "direct", packedBytes: 10n }
const SOLID_FIRST: EntryAccess = { type: "solidBlock", skippedBytes: 0n, estimatedPackedBytes: 400n, blockPackedBytes: 9000n }
const SOLID_LATER: EntryAccess = {
	type: "solidBlock",
	skippedBytes: 5_000_000n,
	estimatedPackedBytes: 2_000_000n,
	blockPackedBytes: 9_000_000n
}
const SEQUENTIAL: EntryAccess = { type: "sequential" }

function only(spec: EntrySpec) {
	return storeOf([spec])
}

describe("entry access", () => {
	it("reads a zip's or 7z's file alone, never a tar's member, a skipped entry or anything but a file", () => {
		expect(canReadEntry(only({ path: "a.txt", access: DIRECT }), 0)).toBe(true)
		expect(canReadEntry(only({ path: "a.txt", access: SOLID_LATER }), 0)).toBe(true)
		expect(canReadEntry(only({ path: "a.txt", access: SEQUENTIAL }), 0)).toBe(false)
		// A bare tar's member: read by range from where its listing found it.
		expect(canReadEntry(storeOf([{ path: "a.txt", access: SEQUENTIAL, size: 3 }], undefined, true), 0)).toBe(true)
		expect(canReadEntry(only({ path: "a.txt" }), 0)).toBe(false)
		expect(canReadEntry(only({ path: "a.txt", access: DIRECT, skip: "unsafePath" }), 0)).toBe(false)
		expect(canReadEntry(only({ path: "l", kind: { type: "hardlink", target: "a", targetId: undefined }, access: DIRECT }), 0)).toBe(
			false
		)
	})

	it("shows media and RAW entries their viewer cannot read from here as their Extract card", () => {
		const MIB = 1024 * 1024

		for (const access of ["mapped", "seekable"] as const) {
			expect(entryExtractCard("video", access, 4096 * MIB)).toBeNull()
			expect(entryExtractCard("rawImage", access, 40 * MIB)).toBeNull()
		}

		expect(entryExtractCard("audio", "whole", 64 * MIB)).toBeNull()
		expect(entryExtractCard("audio", "whole", 64 * MIB + 1)).toBe("play")
		expect(entryExtractCard("video", "sequential", 1)).toBe("play")
		expect(entryExtractCard("rawImage", "whole", 1)).toBe("open")
		expect(entryExtractCard("pdf", "whole", 1)).toBeNull()
	})

	it("opens the categories the preview loads whole within their caps, and media and RAW by their access", () => {
		expect(entryPreviewCategory("notes.md")).toBe("markdown")
		expect(entryPreviewCategory("photo.HEIC")).toBe("image")
		expect(entryPreviewCategory("Makefile")).toBe("code")
		expect(entryPreviewCategory("clip.mp4")).toBe("video")
		expect(entryPreviewCategory("song.mp3")).toBe("audio")
		expect(entryPreviewCategory("raw.nef")).toBe("rawImage")
		expect(entryPreviewCategory("inner.zip")).toBeNull()
		expect(entryPreviewCategory("blob.bin")).toBeNull()

		expect(canOpenEntry(only({ path: "doc.pdf", access: DIRECT }), 0)).toBe(true)
		expect(canOpenEntry(only({ path: "doc.pdf", access: SEQUENTIAL }), 0)).toBe(false)
		expect(canOpenEntry(only({ path: "clip.mp4", access: DIRECT, size: 4 * 1024 ** 3 }), 0)).toBe(true)
		expect(canOpenEntry(only({ path: "clip.mp4", access: SEQUENTIAL }), 0)).toBe(false)

		const cap = Number(SPREADSHEET_MAX_BYTES)

		expect(canOpenEntry(only({ path: "sheet.xlsx", access: DIRECT, size: cap }), 0)).toBe(true)
		expect(canOpenEntry(only({ path: "sheet.xlsx", access: DIRECT, size: cap + 1 }), 0)).toBe(false)
	})

	it("asks before a solid entry that decodes others first, and allows exactly the listed skip", () => {
		const store = storeOf([
			{ path: "a", access: DIRECT },
			{ path: "b", access: SOLID_FIRST },
			{ path: "c", access: SOLID_LATER }
		])

		expect(needsCostConfirm(store, 0)).toBe(false)
		expect(needsCostConfirm(store, 1)).toBe(false)
		expect(needsCostConfirm(store, 2)).toBe(true)
		expect(entryCost(store, 0)).toBeNull()
		expect(entryCost(store, 2)).toEqual({ skippedBytes: 5_000_000, estimatedBytes: 2_000_000 })
		expect(maxSolidSkipFor(store, 0)).toBe(0)
		expect(maxSolidSkipFor(store, 1)).toBe(0)
		expect(maxSolidSkipFor(store, 2)).toBe(5_000_000)
	})

	it("tells an encrypted entry", () => {
		expect(isEncryptedEntry(only({ path: "a", access: DIRECT, encrypted: true }), 0)).toBe(true)
		expect(isEncryptedEntry(only({ path: "a", access: DIRECT }), 0)).toBe(false)
	})
})

describe("entryRequest", () => {
	const source: ArchiveSource = {
		file: { uuid: TEST_ARCHIVE } as unknown as AnyFile,
		uuid: TEST_ARCHIVE,
		name: "a.7z",
		size: 1,
		anon: false,
		nested: null,
		ownParent: null
	}

	it("names the entry by its index with the skip the listing stated, never null", () => {
		const store = storeOf([
			{ path: "a.txt", index: 7, size: 12, access: DIRECT },
			{ path: "b.txt", index: 9, size: 3, access: SOLID_LATER }
		])

		expect(entryRequest(source, store, 0)).toEqual({
			params: { archive: source.file, entry: { archive: TEST_ARCHIVE, index: 7 }, maxSolidSkip: 0 },
			anon: false,
			target: source,
			name: "a.txt",
			size: 12
		})
		expect(entryRequest(source, store, 1)?.params.maxSolidSkip).toBe(5_000_000)
	})

	it("refuses what the SDK cannot read alone", () => {
		expect(entryRequest(source, only({ path: "a.txt", access: SEQUENTIAL }), 0)).toBeNull()
		expect(entryRequest(source, only({ path: "a.txt" }), 0)).toBeNull()
	})
})

describe("archiveEntryItem", () => {
	it("stands in for the entry under its own key, outside the drive", () => {
		const item = archiveEntryItem(TEST_ARCHIVE, 4, "logo.svg", 120, 1_700_000_000_000)

		expect(item.data.uuid).toBe(entryKey(TEST_ARCHIVE, 4))
		expect(entryKey(TEST_ARCHIVE, 4)).toBe(`${TEST_ARCHIVE}#4`)
		expect(item.data.size).toBe(120n)
		expect(isLinkedEmbedItem(item)).toBe(true)
		expect(previewType(item)).toBe("image")
		expect(driveItemMime(item)).toBe("image/svg+xml")
	})

	it("reads its type from its name alone", () => {
		expect(previewType(archiveEntryItem(TEST_ARCHIVE, 0, "a.docx", 1, NaN))).toBe("docx")
		expect(driveItemMime(archiveEntryItem(TEST_ARCHIVE, 0, "a.docx", 1, NaN))).toBe("application/octet-stream")
	})

	it("types each image entry the inline route may serve by its extension, and every other viewed entry as generic binary", () => {
		const typed = new Map([
			["jpg", "image/jpeg"],
			["jpeg", "image/jpeg"],
			["png", "image/png"],
			["gif", "image/gif"],
			["webp", "image/webp"],
			["svg", "image/svg+xml"],
			["bmp", "image/bmp"],
			["ico", "image/x-icon"],
			["apng", "image/apng"],
			["avif", "image/avif"],
			["heic", "image/heic"],
			["heif", "image/heif"],
			["hif", "image/heif"]
		])

		const generic = ["tiff", "pdf", "docx", "xlsx", "pptx", "txt", "md", "json", "html"]

		for (const extension of [...typed.keys(), ...generic]) {
			const item = archiveEntryItem(TEST_ARCHIVE, 0, `entry.${extension}`, 1, NaN)

			expect(driveItemMime(item)).toBe(typed.get(extension) ?? "application/octet-stream")
		}
	})
})

describe("sniffedEntryCategory", () => {
	it("opens text past its cap as large text only where the origin serves ranges", () => {
		const large = linkedFileItem("server.log", { size: TEXT_MAX_BYTES + 1n })
		const huge = linkedFileItem("server.log", { size: ENTRY_RANGE_BUFFER_CAP + 1n })
		const entry = (size: bigint) =>
			({
				kind: "entry",
				reader: "r",
				entry: { archive: TEST_ARCHIVE, index: 0 },
				size: Number(size),
				access: "whole",
				anon: false,
				cacheKey: "a#0"
			}) satisfies ByteOrigin

		expect(sniffedEntryCategory(large, { kind: "bytes", blob: new Blob([]), cacheKey: "m#0" })).toBe("text")
		expect(sniffedEntryCategory(huge, { kind: "bytes", blob: new Blob([]), cacheKey: "m#0" })).toBe("text")
		expect(sniffedEntryCategory(large, entry(TEXT_MAX_BYTES + 1n))).toBe("text")
		expect(sniffedEntryCategory(huge, entry(ENTRY_RANGE_BUFFER_CAP + 1n))).toBeNull()
	})
})

describe("entries whose content read picks the viewer", () => {
	it("asks the access of an entry whose read may find media, never of one it may only find text in", () => {
		expect(sniffMayReadByRange("song.mod")).toBe(true)
		expect(sniffMayReadByRange("notes.txt")).toBe(false)
	})

	it("opens a RAW an archive's reader walks by range, never one the page holds as bytes", () => {
		const entryOrigin = (index: number): ByteOrigin => ({
			kind: "entry",
			reader: "r",
			entry: { archive: TEST_ARCHIVE, index },
			size: 10,
			access: "mapped",
			anon: false,
			cacheKey: `a#${String(index)}`
		})
		const heldOrigin: ByteOrigin = { kind: "bytes", blob: new Blob([]), cacheKey: "m#0" }
		const raw = archiveEntryItem(TEST_ARCHIVE, 1, "photo.nef", 10, Number.NaN)
		const clip = archiveEntryItem(TEST_ARCHIVE, 2, "clip.mp4", 10, Number.NaN)

		expect(sniffedEntryCategory(raw, entryOrigin(1))).toBe("rawImage")
		expect(sniffedEntryCategory(raw, heldOrigin)).toBeNull()
		expect(sniffedEntryCategory(clip, heldOrigin)).toBe("video")
	})
})

describe("archives held in an entry", () => {
	it("are archives and comics read alone, never a ZIP package a viewer of its own shows", () => {
		const store = storeOf([
			{ path: "inner.zip", size: 10, access: DIRECT },
			{ path: "book.cbz", size: 10, access: DIRECT },
			{ path: "report.docx", size: 10, access: DIRECT },
			{ path: "deep.7z", size: 10, access: SOLID_LATER }
		])

		expect([0, 1, 2].map(slot => holdsNestedArchive(store, slot))).toEqual([true, true, false])
		expect(holdsNestedArchive(store, 3)).toBe(canReadEntry(store, 3))
	})

	it("open in place when stored, after a confirm when inflated above 256 MiB, else as the card", () => {
		expect(nestedOpening("mapped", NESTED_INFLATE_CONFIRM_BYTES * 2)).toBe("enter")
		expect(nestedOpening("seekable", NESTED_INFLATE_CONFIRM_BYTES)).toBe("enter")
		expect(nestedOpening("seekable", NESTED_INFLATE_CONFIRM_BYTES + 1)).toBe("confirm")
		expect(nestedOpening("whole", 10)).toBe("extract")
		expect(nestedOpening("sequential", 10)).toBe("extract")
	})
})
