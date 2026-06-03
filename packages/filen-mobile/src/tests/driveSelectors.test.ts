import { vi, describe, it, expect } from "vitest"

// Mock @/constants so extension sets are stable and platform-independent.
// The real constants.ts uses Platform.select() which returns iOS-specific sets
// when the react-native mock reports OS = 'ios'. We pin a minimal known-good
// superset here so that tests never silently depend on the mock's Platform.OS.
vi.mock("@/constants", () => ({
	EXPO_IMAGE_SUPPORTED_EXTENSIONS: new Set<string>([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".svg"]),
	EXPO_VIDEO_SUPPORTED_EXTENSIONS: new Set<string>([".mp4", ".mov", ".m4v", ".3gp", ".webm"])
}))

import { aggregateDriveSelectionFlags, EMPTY_DRIVE_FLAGS } from "@/lib/driveSelectors"
import type { DriveItem } from "@/types"

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function file(uuid: string, favorited = false, name?: string, undecryptable = false): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			favorited,
			undecryptable,
			decryptedMeta: name ? ({ name } as DriveItem["data"]["decryptedMeta"]) : null
		} as DriveItem["data"]
	} as DriveItem
}

function dir(uuid: string, favorited = false, undecryptable = false): DriveItem {
	return {
		type: "directory",
		data: { uuid, favorited, undecryptable } as DriveItem["data"]
	} as DriveItem
}

function sharedRootFile(uuid: string, name?: string, undecryptable = false): DriveItem {
	return {
		type: "sharedRootFile",
		data: {
			uuid,
			undecryptable,
			decryptedMeta: name ? ({ name } as DriveItem["data"]["decryptedMeta"]) : null
		} as DriveItem["data"]
	} as DriveItem
}

function sharedRootDir(uuid: string, undecryptable = false): DriveItem {
	return {
		type: "sharedRootDirectory",
		data: { uuid, undecryptable } as DriveItem["data"]
	} as DriveItem
}

// sharedFile = DriveItemFileSharedNonRoot = File & SharedFile & ExtraData.
// File carries `favorited`, so it IS present in the data shape.
function sharedFile(uuid: string, favorited = false, name?: string, undecryptable = false): DriveItem {
	return {
		type: "sharedFile",
		data: {
			uuid,
			favorited,
			undecryptable,
			decryptedMeta: name ? ({ name } as DriveItem["data"]["decryptedMeta"]) : null
		} as DriveItem["data"]
	} as DriveItem
}

// sharedDirectory = DriveItemDirectorySharedNonRoot = SharedDir & ExtraData.
// SharedDir wraps { inner: Dir } — the top-level shape does NOT have `favorited`
// directly, so the "favorited in it.data" guard will be false.
function sharedDirectory(uuid: string, undecryptable = false): DriveItem {
	return {
		type: "sharedDirectory",
		data: { uuid, undecryptable } as DriveItem["data"]
	} as DriveItem
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregateDriveSelectionFlags", () => {
	it("returns EMPTY_DRIVE_FLAGS by reference on empty selection", () => {
		expect(aggregateDriveSelectionFlags([])).toBe(EMPTY_DRIVE_FLAGS)
	})

	it("EMPTY_DRIVE_FLAGS has all flags false and count zero", () => {
		expect(EMPTY_DRIVE_FLAGS.count).toBe(0)
		expect(EMPTY_DRIVE_FLAGS.includesFavorited).toBe(false)
		expect(EMPTY_DRIVE_FLAGS.everyFile).toBe(false)
		expect(EMPTY_DRIVE_FLAGS.everyDirectory).toBe(false)
		expect(EMPTY_DRIVE_FLAGS.everyImageOrVideoFile).toBe(false)
		expect(EMPTY_DRIVE_FLAGS.includesUndecryptable).toBe(false)
	})

	it("non-empty call does NOT return the EMPTY_DRIVE_FLAGS constant by reference", () => {
		const result = aggregateDriveSelectionFlags([file("a")])

		expect(result).not.toBe(EMPTY_DRIVE_FLAGS)
	})

	it("counts selected items", () => {
		expect(aggregateDriveSelectionFlags([file("a"), dir("b"), file("c")]).count).toBe(3)
	})

	it("includesFavorited true when any item is favorited", () => {
		expect(aggregateDriveSelectionFlags([file("a"), file("b", true)]).includesFavorited).toBe(true)
	})

	it("includesFavorited false when none favorited", () => {
		expect(aggregateDriveSelectionFlags([file("a"), file("b")]).includesFavorited).toBe(false)
	})

	// -------------------------------------------------------------------------
	// everyFile
	// -------------------------------------------------------------------------

	it("everyFile true for all three file variants (file / sharedFile / sharedRootFile)", () => {
		// plain file only
		expect(aggregateDriveSelectionFlags([file("a"), file("b")]).everyFile).toBe(true)
		// mix of all three file variants
		expect(
			aggregateDriveSelectionFlags([file("a"), sharedFile("b"), sharedRootFile("c")]).everyFile
		).toBe(true)
		// sharedFile alone
		expect(aggregateDriveSelectionFlags([sharedFile("a"), sharedFile("b")]).everyFile).toBe(true)
		// sharedRootFile alone
		expect(aggregateDriveSelectionFlags([sharedRootFile("a")]).everyFile).toBe(true)
	})

	it("everyFile false when any item is a directory variant", () => {
		expect(aggregateDriveSelectionFlags([file("a"), dir("b")]).everyFile).toBe(false)
		expect(aggregateDriveSelectionFlags([sharedFile("a"), dir("b")]).everyFile).toBe(false)
		expect(aggregateDriveSelectionFlags([sharedRootFile("a"), sharedRootDir("b")]).everyFile).toBe(false)
	})

	// -------------------------------------------------------------------------
	// everyDirectory
	// -------------------------------------------------------------------------

	it("everyDirectory true for all three directory variants (directory / sharedDirectory / sharedRootDirectory)", () => {
		// plain directory only
		expect(aggregateDriveSelectionFlags([dir("a"), dir("b")]).everyDirectory).toBe(true)
		// mix of all three dir variants
		expect(
			aggregateDriveSelectionFlags([dir("a"), sharedDirectory("b"), sharedRootDir("c")]).everyDirectory
		).toBe(true)
		// sharedDirectory alone
		expect(aggregateDriveSelectionFlags([sharedDirectory("a"), sharedDirectory("b")]).everyDirectory).toBe(true)
		// sharedRootDirectory alone
		expect(aggregateDriveSelectionFlags([sharedRootDir("a")]).everyDirectory).toBe(true)
	})

	it("everyDirectory false when any item is a file variant", () => {
		expect(aggregateDriveSelectionFlags([dir("a"), file("b")]).everyDirectory).toBe(false)
		expect(aggregateDriveSelectionFlags([sharedDirectory("a"), sharedFile("b")]).everyDirectory).toBe(false)
	})

	it("everyFile and everyDirectory both false on mixed selection", () => {
		const flags = aggregateDriveSelectionFlags([file("a"), dir("b")])

		expect(flags.everyFile).toBe(false)
		expect(flags.everyDirectory).toBe(false)
	})

	// -------------------------------------------------------------------------
	// everyImageOrVideoFile
	// -------------------------------------------------------------------------

	it("everyImageOrVideoFile false when selection includes any directory", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), dir("b")]).everyImageOrVideoFile
		).toBe(false)
	})

	it("everyImageOrVideoFile false when any file lacks decryptedMeta", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), file("b")]).everyImageOrVideoFile
		).toBe(false)
	})

	it("everyImageOrVideoFile false when any file has a non-image/video extension", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), file("b", false, "doc.pdf")])
				.everyImageOrVideoFile
		).toBe(false)
	})

	it("everyImageOrVideoFile false when filename has no extension", () => {
		// A file named 'README' has no dot — ext resolves to '' which is not in either set.
		expect(
			aggregateDriveSelectionFlags([file("a", false, "README")]).everyImageOrVideoFile
		).toBe(false)
	})

	it("everyImageOrVideoFile false when filename is only a dot (no real ext)", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, ".")]).everyImageOrVideoFile
		).toBe(false)
	})

	it("everyImageOrVideoFile true for all-image selection (type: file)", () => {
		expect(
			aggregateDriveSelectionFlags([
				file("a", false, "photo.jpg"),
				file("b", false, "graphic.png"),
				file("c", false, "still.heic")
			]).everyImageOrVideoFile
		).toBe(true)
	})

	it("everyImageOrVideoFile true for mixed image + video selection (type: file)", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), file("b", false, "clip.mp4")])
				.everyImageOrVideoFile
		).toBe(true)
	})

	it("everyImageOrVideoFile true when extension is uppercase (case-insensitive match)", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, "PHOTO.JPG"), file("b", false, "graphic.PNG")])
				.everyImageOrVideoFile
		).toBe(true)
	})

	it("everyImageOrVideoFile true when sharedRootFile carries an image extension", () => {
		const sharedImg = sharedRootFile("s1", "shared.jpg")

		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), sharedImg]).everyImageOrVideoFile
		).toBe(true)
	})

	it("everyImageOrVideoFile true when sharedFile (non-root) carries an image extension", () => {
		// sharedFile is one of the three FILE_TYPES variants — it must participate in the image/video check.
		const sharedImg = sharedFile("s2", false, "shared.png")

		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), sharedImg]).everyImageOrVideoFile
		).toBe(true)
	})

	it("everyImageOrVideoFile false when sharedFile (non-root) has a non-image extension", () => {
		const sharedPdf = sharedFile("s3", false, "document.pdf")

		expect(aggregateDriveSelectionFlags([sharedPdf]).everyImageOrVideoFile).toBe(false)
	})

	it("everyImageOrVideoFile false on empty selection (via EMPTY_DRIVE_FLAGS)", () => {
		expect(aggregateDriveSelectionFlags([]).everyImageOrVideoFile).toBe(false)
	})

	// -------------------------------------------------------------------------
	// includesUndecryptable
	// -------------------------------------------------------------------------

	it("includesUndecryptable true when any item is undecryptable", () => {
		const decryptable = file("a", false, "photo.jpg")
		const undecryptable = file("b", false, undefined, true)

		expect(aggregateDriveSelectionFlags([decryptable, undecryptable]).includesUndecryptable).toBe(true)
	})

	it("includesUndecryptable false when no item is undecryptable", () => {
		expect(aggregateDriveSelectionFlags([file("a", false, "photo.jpg")]).includesUndecryptable).toBe(false)
	})

	it("includesUndecryptable false on empty selection (via EMPTY_DRIVE_FLAGS)", () => {
		expect(aggregateDriveSelectionFlags([]).includesUndecryptable).toBe(false)
	})

	// -------------------------------------------------------------------------
	// favorited guard on SharedRoot* types (no `favorited` field in data)
	// -------------------------------------------------------------------------

	it("includesFavorited false for sharedRootFile item with no favorited field in data", () => {
		// sharedRootFile data does not carry `favorited` — the source guards with `"favorited" in it.data`
		const item: DriveItem = {
			type: "sharedRootFile",
			data: { uuid: "x", undecryptable: false, decryptedMeta: null } as DriveItem["data"]
		} as DriveItem

		expect(aggregateDriveSelectionFlags([item]).includesFavorited).toBe(false)
	})

	it("includesFavorited false for sharedRootDirectory item with no favorited field in data", () => {
		const item: DriveItem = {
			type: "sharedRootDirectory",
			data: { uuid: "x", undecryptable: false, decryptedMeta: null } as DriveItem["data"]
		} as DriveItem

		expect(aggregateDriveSelectionFlags([item]).includesFavorited).toBe(false)
	})

	it("includesFavorited true for sharedFile item with favorited=true (File carries favorited)", () => {
		// DriveItemFileSharedNonRoot = File & SharedFile & ExtraData.
		// File has a `favorited` boolean, so `"favorited" in it.data` is true.
		expect(aggregateDriveSelectionFlags([sharedFile("a", true)]).includesFavorited).toBe(true)
	})
})
