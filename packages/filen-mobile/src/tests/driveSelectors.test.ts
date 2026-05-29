import { describe, it, expect } from "vitest"
import { aggregateDriveSelectionFlags, EMPTY_DRIVE_FLAGS } from "@/lib/driveSelectors"
import type { DriveItem } from "@/types"

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

function sharedRootFile(uuid: string, favorited = false, undecryptable = false): DriveItem {
	return {
		type: "sharedRootFile",
		data: { uuid, favorited, undecryptable } as DriveItem["data"]
	} as DriveItem
}

function sharedRootDir(uuid: string, favorited = false, undecryptable = false): DriveItem {
	return {
		type: "sharedRootDirectory",
		data: { uuid, favorited, undecryptable } as DriveItem["data"]
	} as DriveItem
}

describe("aggregateDriveSelectionFlags", () => {
	it("returns EMPTY_DRIVE_FLAGS on empty selection", () => {
		expect(aggregateDriveSelectionFlags([])).toBe(EMPTY_DRIVE_FLAGS)
	})

	it("EMPTY_DRIVE_FLAGS is frozen", () => {
		expect(Object.isFrozen(EMPTY_DRIVE_FLAGS)).toBe(true)
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

	it("everyFile true only when every item is a file (any of the 3 file variants)", () => {
		expect(aggregateDriveSelectionFlags([file("a"), file("b")]).everyFile).toBe(true)
		expect(aggregateDriveSelectionFlags([file("a"), sharedRootFile("b")]).everyFile).toBe(true)
		expect(aggregateDriveSelectionFlags([file("a"), dir("b")]).everyFile).toBe(false)
	})

	it("everyDirectory true only when every item is a directory variant", () => {
		expect(aggregateDriveSelectionFlags([dir("a"), dir("b")]).everyDirectory).toBe(true)
		expect(aggregateDriveSelectionFlags([dir("a"), sharedRootDir("b")]).everyDirectory).toBe(true)
		expect(aggregateDriveSelectionFlags([dir("a"), file("b")]).everyDirectory).toBe(false)
	})

	it("everyFile and everyDirectory both false on mixed selection", () => {
		const flags = aggregateDriveSelectionFlags([file("a"), dir("b")])

		expect(flags.everyFile).toBe(false)
		expect(flags.everyDirectory).toBe(false)
	})

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

	it("everyImageOrVideoFile false when any file is a non-image/video extension", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), file("b", false, "doc.pdf")])
				.everyImageOrVideoFile
		).toBe(false)
	})

	it("everyImageOrVideoFile true for all-image selection", () => {
		expect(
			aggregateDriveSelectionFlags([
				file("a", false, "photo.jpg"),
				file("b", false, "graphic.PNG"),
				file("c", false, "still.heic")
			]).everyImageOrVideoFile
		).toBe(true)
	})

	it("everyImageOrVideoFile true for mixed image + video selection", () => {
		expect(
			aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), file("b", false, "clip.mp4")])
				.everyImageOrVideoFile
		).toBe(true)
	})

	it("everyImageOrVideoFile true when sharedRootFile carries an image extension", () => {
		const sharedImg: DriveItem = {
			type: "sharedRootFile",
			data: {
				uuid: "s1",
				decryptedMeta: { name: "shared.jpg" }
			} as DriveItem["data"]
		} as DriveItem

		expect(aggregateDriveSelectionFlags([file("a", false, "photo.jpg"), sharedImg]).everyImageOrVideoFile).toBe(true)
	})

	it("everyImageOrVideoFile false on empty selection (EMPTY_DRIVE_FLAGS)", () => {
		expect(aggregateDriveSelectionFlags([]).everyImageOrVideoFile).toBe(false)
	})

	it("includesUndecryptable true when any item is undecryptable", () => {
		const decryptable = file("a", false, "photo.jpg")
		const undecryptable = file("b", false, undefined, true)

		expect(aggregateDriveSelectionFlags([decryptable, undecryptable]).includesUndecryptable).toBe(true)
	})

	it("includesUndecryptable false when no item is undecryptable", () => {
		const decryptable = file("a", false, "photo.jpg")

		expect(aggregateDriveSelectionFlags([decryptable]).includesUndecryptable).toBe(false)
	})

	it("includesUndecryptable false on empty selection (EMPTY_DRIVE_FLAGS)", () => {
		expect(aggregateDriveSelectionFlags([]).includesUndecryptable).toBe(false)
	})

	it("includesFavorited false for sharedRootFile item with no favorited field in data", () => {
		// sharedRootFile/sharedRootDirectory do not carry favorited — the source code guards
		// with `"favorited" in it.data`. Verify the guard fires correctly when the field is absent.
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
})
