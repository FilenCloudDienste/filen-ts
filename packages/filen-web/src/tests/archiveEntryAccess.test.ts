import { describe, expect, it, vi } from "vitest"
import type { AnyFile, EntryAccess } from "@filen/sdk-rs"
import {
	canOpenEntry,
	canReadEntry,
	entryCost,
	entryKey,
	entryPreviewCategory,
	isEncryptedEntry,
	maxSolidSkipFor,
	needsCostConfirm
} from "@/features/archive/lib/entryAccess.logic"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { driveItemMime, isLinkedEmbedItem } from "@/features/drive/lib/item"
import { previewType, SPREADSHEET_MAX_BYTES } from "@/features/drive/lib/preview.logic"
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
		expect(canReadEntry(only({ path: "a.txt" }), 0)).toBe(false)
		expect(canReadEntry(only({ path: "a.txt", access: DIRECT, skip: "unsafePath" }), 0)).toBe(false)
		expect(canReadEntry(only({ path: "l", kind: { type: "hardlink", target: "a", targetId: undefined }, access: DIRECT }), 0)).toBe(
			false
		)
	})

	it("opens only the categories the preview loads whole, within their caps", () => {
		expect(entryPreviewCategory("notes.md")).toBe("markdown")
		expect(entryPreviewCategory("photo.HEIC")).toBe("image")
		expect(entryPreviewCategory("Makefile")).toBe("code")
		expect(entryPreviewCategory("clip.mp4")).toBeNull()
		expect(entryPreviewCategory("song.mp3")).toBeNull()
		expect(entryPreviewCategory("raw.nef")).toBeNull()
		expect(entryPreviewCategory("inner.zip")).toBeNull()
		expect(entryPreviewCategory("blob.bin")).toBeNull()

		expect(canOpenEntry(only({ path: "doc.pdf", access: DIRECT }), 0)).toBe(true)
		expect(canOpenEntry(only({ path: "doc.pdf", access: SEQUENTIAL }), 0)).toBe(false)
		expect(canOpenEntry(only({ path: "clip.mp4", access: DIRECT }), 0)).toBe(false)

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
		ownParent: null
	}

	it("names the entry by its index with the skip the listing stated, never null", () => {
		const store = storeOf([
			{ path: "a.txt", index: 7, size: 12, access: DIRECT },
			{ path: "b.txt", index: 9, size: 3, access: SOLID_LATER }
		])

		expect(entryRequest(source, store, 0)).toEqual({
			params: { archive: source.file, entry: { archive: TEST_ARCHIVE, index: 7 }, maxSolidSkip: 0 },
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
})
