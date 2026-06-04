import { vi, describe, it, expect } from "vitest"

// Mock @/constants so extension sets are stable and platform-independent.
// The real constants.ts uses Platform.select() which returns iOS-specific sets
// when the react-native mock reports OS = 'ios'. We pin a minimal known-good
// superset here so that tests never silently depend on the mock's Platform.OS.
vi.mock("@/constants", () => ({
	EXPO_IMAGE_SUPPORTED_EXTENSIONS: new Set<string>([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".svg"]),
	EXPO_VIDEO_SUPPORTED_EXTENSIONS: new Set<string>([".mp4", ".mov", ".m4v", ".3gp", ".webm"])
}))

// resolveDriveNavigationTarget serializes selectOptions/linked via @/lib/serializer,
// which would otherwise pull in uniffi-bindgen-react-native. Stub it with a
// deterministic, inspectable serialization for the navigation-target assertions.
vi.mock("@/lib/serializer", () => ({
	serialize: (value: unknown) => `serialized:${JSON.stringify(value)}`
}))

import {
	aggregateDriveSelectionFlags,
	EMPTY_DRIVE_FLAGS,
	isDriveItemDisabled,
	isDriveItemNavigateOnly,
	resolveDriveNavigationTarget
} from "@/features/drive/driveSelectors"
import type { DriveItem } from "@/types"
import type { DrivePath, SelectOptions } from "@/hooks/useDrivePath"

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

// ---------------------------------------------------------------------------
// DrivePath / SelectOptions helpers for the navigation/disabled selectors
// ---------------------------------------------------------------------------

function drivePath(type: DrivePath["type"], extra?: Partial<DrivePath>): DrivePath {
	return {
		type,
		uuid: null,
		...extra
	} as DrivePath
}

function selectOptions(over: Partial<SelectOptions>): SelectOptions {
	return {
		type: "single",
		files: true,
		directories: true,
		intention: "select",
		items: [],
		id: "id",
		...over
	} as SelectOptions
}

describe("isDriveItemDisabled", () => {
	it("returns false outside picker mode (no selectOptions)", () => {
		expect(
			isDriveItemDisabled({
				item: file("a"),
				drivePath: drivePath("drive"),
				previewType: null,
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(false)
	})

	// --- move intention ---

	it("move: undecryptable item is disabled", () => {
		expect(
			isDriveItemDisabled({
				item: dir("a", false, true),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ intention: "move", directories: true, files: false }) }),
				previewType: null,
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(true)
	})

	it("move: item already in the move set is disabled", () => {
		const target = dir("a")

		expect(
			isDriveItemDisabled({
				item: target,
				drivePath: drivePath("drive", {
					selectOptions: selectOptions({ intention: "move", directories: true, files: false, items: [target] })
				}),
				previewType: null,
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(true)
	})

	it("move: unrelated item is enabled", () => {
		expect(
			isDriveItemDisabled({
				item: dir("a"),
				drivePath: drivePath("drive", {
					selectOptions: selectOptions({ intention: "move", directories: true, files: false, items: [dir("b")] })
				}),
				previewType: null,
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(false)
	})

	// --- select intention ---

	it("select: undecryptable item is disabled", () => {
		expect(
			isDriveItemDisabled({
				item: file("a", false, undefined, true),
				drivePath: drivePath("drive", { selectOptions: selectOptions({}) }),
				previewType: null,
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(true)
	})

	it("select: directory disabled when picker is files-only", () => {
		expect(
			isDriveItemDisabled({
				item: dir("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ files: true, directories: false }) }),
				previewType: null,
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(true)
	})

	it("select: file disabled when picker is directories-only", () => {
		expect(
			isDriveItemDisabled({
				item: file("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ files: false, directories: true }) }),
				previewType: null,
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(true)
	})

	it("select: previewType mismatch disables the row", () => {
		expect(
			isDriveItemDisabled({
				item: file("a", false, "photo.jpg"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ files: true, directories: false, previewType: "video" }) }),
				previewType: "image",
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(true)
	})

	it("select: previewType match keeps the row enabled", () => {
		expect(
			isDriveItemDisabled({
				item: file("a", false, "photo.jpg"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ files: true, directories: false, previewType: "image" }) }),
				previewType: "image",
				selectedFromDriveSelectCount: 0,
				isSelectedFromDriveSelect: false
			})
		).toBe(false)
	})

	it("select/single: another row already picked disables this (unselected) row", () => {
		expect(
			isDriveItemDisabled({
				item: file("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ type: "single" }) }),
				previewType: null,
				selectedFromDriveSelectCount: 1,
				isSelectedFromDriveSelect: false
			})
		).toBe(true)
	})

	it("select/single: the already-selected row itself stays enabled", () => {
		expect(
			isDriveItemDisabled({
				item: file("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ type: "single" }) }),
				previewType: null,
				selectedFromDriveSelectCount: 1,
				isSelectedFromDriveSelect: true
			})
		).toBe(false)
	})

	it("select/multiple: rows stay enabled regardless of selection count", () => {
		expect(
			isDriveItemDisabled({
				item: file("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ type: "multiple" }) }),
				previewType: null,
				selectedFromDriveSelectCount: 5,
				isSelectedFromDriveSelect: false
			})
		).toBe(false)
	})
})

describe("isDriveItemNavigateOnly", () => {
	it("false when the row is not disabled", () => {
		expect(
			isDriveItemNavigateOnly({ item: dir("a"), drivePath: drivePath("drive", { selectOptions: selectOptions({ directories: false }) }), disabled: false })
		).toBe(false)
	})

	it("false outside picker mode", () => {
		expect(isDriveItemNavigateOnly({ item: dir("a"), drivePath: drivePath("drive"), disabled: true })).toBe(false)
	})

	it("false for move intention", () => {
		expect(
			isDriveItemNavigateOnly({
				item: dir("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ intention: "move", directories: false }) }),
				disabled: true
			})
		).toBe(false)
	})

	it("false when picker allows directories", () => {
		expect(
			isDriveItemNavigateOnly({
				item: dir("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ directories: true, files: true }) }),
				disabled: true
			})
		).toBe(false)
	})

	it("true for a directory disabled only because picker is files-only", () => {
		expect(
			isDriveItemNavigateOnly({
				item: dir("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ files: true, directories: false }) }),
				disabled: true
			})
		).toBe(true)
	})

	it("true for every directory variant in a files-only picker", () => {
		const dp = drivePath("drive", { selectOptions: selectOptions({ files: true, directories: false }) })

		expect(isDriveItemNavigateOnly({ item: sharedDirectory("a"), drivePath: dp, disabled: true })).toBe(true)
		expect(isDriveItemNavigateOnly({ item: sharedRootDir("b"), drivePath: dp, disabled: true })).toBe(true)
	})

	it("false for a file in a files-only picker (files aren't navigated into)", () => {
		expect(
			isDriveItemNavigateOnly({
				item: file("a"),
				drivePath: drivePath("drive", { selectOptions: selectOptions({ files: true, directories: false }) }),
				disabled: true
			})
		).toBe(false)
	})
})

describe("resolveDriveNavigationTarget", () => {
	it("returns null for a file row", () => {
		expect(resolveDriveNavigationTarget({ item: file("a"), drivePath: drivePath("drive") })).toBeNull()
	})

	it("returns null inside trash (directories aren't navigable there)", () => {
		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("trash") })).toBeNull()
	})

	it("routes /offline directories to /offline/[uuid]", () => {
		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("offline") })).toEqual({
			pathname: "/offline/[uuid]",
			params: { uuid: "a" }
		})
	})

	it("routes /sharedIn directories to /sharedIn/[uuid]", () => {
		expect(resolveDriveNavigationTarget({ item: sharedDirectory("a"), drivePath: drivePath("sharedIn") })).toEqual({
			pathname: "/sharedIn/[uuid]",
			params: { uuid: "a" }
		})
	})

	it("routes /sharedOut directories to /sharedOut/[uuid]", () => {
		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("sharedOut") })).toEqual({
			pathname: "/sharedOut/[uuid]",
			params: { uuid: "a" }
		})
	})

	it("routes /favorites directories to /favorites/[uuid]", () => {
		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("favorites") })).toEqual({
			pathname: "/favorites/[uuid]",
			params: { uuid: "a" }
		})
	})

	it("routes /links directories to /links/[uuid]", () => {
		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("links") })).toEqual({
			pathname: "/links/[uuid]",
			params: { uuid: "a" }
		})
	})

	it("routes picker (selectOptions) directories to /driveSelect/[uuid] with serialized options", () => {
		const opts = selectOptions({ directories: true, files: false, intention: "move" })

		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("drive", { selectOptions: opts }) })).toEqual({
			pathname: "/driveSelect/[uuid]",
			params: { uuid: "a", selectOptions: `serialized:${JSON.stringify(opts)}` }
		})
	})

	it("routes /linked directories to /linkedDir/[uuid] with serialized linked payload", () => {
		const linked = { uuid: "root", key: "k", rootName: "Root" }

		expect(
			resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("linked", { linked }) })
		).toEqual({
			pathname: "/linkedDir/[uuid]",
			params: { uuid: "a", linked: `serialized:${JSON.stringify(linked)}` }
		})
	})

	it("returns null for /linked when the linked payload is missing", () => {
		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("linked") })).toBeNull()
	})

	it("routes plain /drive directories to /tabs/drive/[uuid]", () => {
		expect(resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("drive") })).toEqual({
			pathname: "/tabs/drive/[uuid]",
			params: { uuid: "a" }
		})
	})

	it("picker check takes precedence over the plain /drive fallback", () => {
		// A /drive path WITH selectOptions must route through driveSelect, not /tabs/drive.
		const opts = selectOptions({})
		const target = resolveDriveNavigationTarget({ item: dir("a"), drivePath: drivePath("drive", { selectOptions: opts }) })

		expect(target?.pathname).toBe("/driveSelect/[uuid]")
	})
})
