import { vi, describe, it, expect, beforeEach } from "vitest"
import { type TFunction } from "i18next"

// ---------------------------------------------------------------------------
// Mocks — hoisted so vi.mock factories can reference them safely
// ---------------------------------------------------------------------------

const { mockUuidToAnyDriveItem, mockDriveItemDisplayName } = vi.hoisted(() => {
	const mockUuidToAnyDriveItem = new Map<string, unknown>()
	const mockDriveItemDisplayName = vi.fn((item: unknown) => `display:${(item as { data: { uuid: string } }).data.uuid}`)

	return { mockUuidToAnyDriveItem, mockDriveItemDisplayName }
})

// cache provides the uuid→item map used by resolveDriveHeaderTitle:
//   cache.uuidToAnyDriveItem   — Map<string, DriveItem>
vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: mockUuidToAnyDriveItem
	}
}))

// driveItemDisplayName lives in @/lib/decryption; used by the undecryptable branch
vi.mock("@/lib/decryption", () => ({
	driveItemDisplayName: mockDriveItemDisplayName
}))

// @expo/vector-icons pulls in native modules — stub it
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: {} }))

// ---------------------------------------------------------------------------
// Real module under test
// ---------------------------------------------------------------------------

import {
	getDriveEmptyStateIcon,
	getDriveEmptyStateTitleKey,
	DRIVE_EMPTY_STATE_ICON,
	DRIVE_EMPTY_STATE_TITLE_KEY,
	resolveDriveHeaderTitle,
	rawUploadTimestamp,
	pickDisplayTimestamp,
	directorySizeTypeForDrivePath,
	filterDriveItemsBySearchQuery
} from "@/features/drive/utils"
import type { DrivePath, SelectOptions, DrivePathType } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal t() that returns the key (plus optional count suffix for assertions). */
const t = ((key: string, opts?: { count?: number }): string => {
	if (opts?.count !== undefined) {
		return `${key}:${opts.count}`
	}

	return key
}) as unknown as TFunction

function drivePath(type: DrivePathType, extra?: Partial<DrivePath>): DrivePath {
	return { type, uuid: null, ...extra } as DrivePath
}

function selectOptions(over: Partial<SelectOptions>): SelectOptions {
	return {
		type: "single",
		files: true,
		directories: true,
		intention: "select",
		items: [],
		id: "test-id",
		...over
	} as SelectOptions
}

function undecryptableItem(uuid: string): DriveItem {
	return {
		type: "directory",
		data: { uuid, undecryptable: true, decryptedMeta: null } as DriveItem["data"]
	} as DriveItem
}

function decryptableItem(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
		data: { uuid, undecryptable: false, decryptedMeta: { name } } as DriveItem["data"]
	} as DriveItem
}

// ---------------------------------------------------------------------------
// #29 — getDriveEmptyStateIcon / getDriveEmptyStateTitleKey null-input fallback
// ---------------------------------------------------------------------------

describe("getDriveEmptyStateIcon", () => {
	it("null input falls back to the drive (folder-open-outline) icon", () => {
		expect(getDriveEmptyStateIcon(null)).toBe("folder-open-outline")
		expect(getDriveEmptyStateIcon(null)).toBe(DRIVE_EMPTY_STATE_ICON.drive)
	})

	it("trash → trash-outline", () => {
		expect(getDriveEmptyStateIcon("trash")).toBe("trash-outline")
	})

	it("favorites → heart-outline", () => {
		expect(getDriveEmptyStateIcon("favorites")).toBe("heart-outline")
	})

	it("recents → time-outline", () => {
		expect(getDriveEmptyStateIcon("recents")).toBe("time-outline")
	})

	it("offline → cloud-offline-outline", () => {
		expect(getDriveEmptyStateIcon("offline")).toBe("cloud-offline-outline")
	})

	it("links → link-outline", () => {
		expect(getDriveEmptyStateIcon("links")).toBe("link-outline")
	})

	it("sharedIn → people-outline", () => {
		expect(getDriveEmptyStateIcon("sharedIn")).toBe("people-outline")
	})

	it("sharedOut → people-outline", () => {
		expect(getDriveEmptyStateIcon("sharedOut")).toBe("people-outline")
	})

	it("drive → folder-open-outline", () => {
		expect(getDriveEmptyStateIcon("drive")).toBe("folder-open-outline")
	})

	it("photos → folder-open-outline", () => {
		expect(getDriveEmptyStateIcon("photos")).toBe("folder-open-outline")
	})

	it("linked → folder-open-outline", () => {
		expect(getDriveEmptyStateIcon("linked")).toBe("folder-open-outline")
	})
})

describe("getDriveEmptyStateTitleKey", () => {
	it("null input falls back to folder_is_empty (drive variant)", () => {
		expect(getDriveEmptyStateTitleKey(null)).toBe("folder_is_empty")
		expect(getDriveEmptyStateTitleKey(null)).toBe(DRIVE_EMPTY_STATE_TITLE_KEY.drive)
	})

	it("trash → trash_is_empty", () => {
		expect(getDriveEmptyStateTitleKey("trash")).toBe("trash_is_empty")
	})

	it("favorites → no_favorites", () => {
		expect(getDriveEmptyStateTitleKey("favorites")).toBe("no_favorites")
	})

	it("recents → no_recents", () => {
		expect(getDriveEmptyStateTitleKey("recents")).toBe("no_recents")
	})

	it("sharedIn → no_shared_in_items", () => {
		expect(getDriveEmptyStateTitleKey("sharedIn")).toBe("no_shared_in_items")
	})

	it("sharedOut → no_shared_out_items", () => {
		expect(getDriveEmptyStateTitleKey("sharedOut")).toBe("no_shared_out_items")
	})

	it("links → no_links", () => {
		expect(getDriveEmptyStateTitleKey("links")).toBe("no_links")
	})

	it("offline → no_offline_items", () => {
		expect(getDriveEmptyStateTitleKey("offline")).toBe("no_offline_items")
	})

	it("drive → folder_is_empty", () => {
		expect(getDriveEmptyStateTitleKey("drive")).toBe("folder_is_empty")
	})

	it("photos → folder_is_empty", () => {
		expect(getDriveEmptyStateTitleKey("photos")).toBe("folder_is_empty")
	})

	it("linked → folder_is_empty", () => {
		expect(getDriveEmptyStateTitleKey("linked")).toBe("folder_is_empty")
	})
})

// ---------------------------------------------------------------------------
// #28 — resolveDriveHeaderTitle — all branching paths
// ---------------------------------------------------------------------------

describe("resolveDriveHeaderTitle", () => {
	beforeEach(() => {
		mockUuidToAnyDriveItem.clear()
		mockDriveItemDisplayName.mockClear()
	})

	// -------------------------------------------------------------------------
	// selectedCount > 0 path (no selectOptions)
	// -------------------------------------------------------------------------

	it("selectedCount > 0 without selectOptions → 'selected:N'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { uuid: "uuid-1" }),
			selectedCount: 3,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("selected:3")
	})

	it("selectedCount > 0 with selectOptions → selectOptions path wins (not selected count)", () => {
		// The selectedCount > 0 guard is skipped when selectOptions is present
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", {
				uuid: "uuid-1",
				selectOptions: selectOptions({ intention: "move" })
			}),
			selectedCount: 5,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_destination")
	})

	it("selectedCount = 0 → does not trigger selected path", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("trash"),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		// trash always returns t("trash")
		expect(result).toBe("trash")
	})

	// -------------------------------------------------------------------------
	// selectOptions.intention = 'move'
	// -------------------------------------------------------------------------

	it("selectOptions intention='move' → 'select_destination'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { selectOptions: selectOptions({ intention: "move" }) }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_destination")
	})

	// -------------------------------------------------------------------------
	// selectOptions.intention = 'select' — 6 sub-cases (files+dirs) × (single/multiple)
	// -------------------------------------------------------------------------

	it("select: files=true dirs=true type='single' → 'select_item'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", {
				selectOptions: selectOptions({ intention: "select", files: true, directories: true, type: "single" })
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_item")
	})

	it("select: files=true dirs=true type='multiple' → 'select_items'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", {
				selectOptions: selectOptions({ intention: "select", files: true, directories: true, type: "multiple" })
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_items")
	})

	it("select: files=false dirs=true type='single' → 'select_directory'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", {
				selectOptions: selectOptions({ intention: "select", files: false, directories: true, type: "single" })
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_directory")
	})

	it("select: files=false dirs=true type='multiple' → 'select_directories'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", {
				selectOptions: selectOptions({ intention: "select", files: false, directories: true, type: "multiple" })
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_directories")
	})

	it("select: files=true dirs=false type='single' → 'select_file'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", {
				selectOptions: selectOptions({ intention: "select", files: true, directories: false, type: "single" })
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_file")
	})

	it("select: files=true dirs=false type='multiple' → 'select_files'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", {
				selectOptions: selectOptions({ intention: "select", files: true, directories: false, type: "multiple" })
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("select_files")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'drive' — root uuid match, cache lookup, undecryptable
	// -------------------------------------------------------------------------

	it("drive: uuid matches stringifiedClientRootUuid → 'drive'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { uuid: "root-uuid" }),
			selectedCount: 0,
			stringifiedClientRootUuid: "root-uuid",
			t: t
		})

		expect(result).toBe("drive")
	})

	it("drive: uuid in cache.uuidToAnyDriveItem (decryptable) → decrypted name", () => {
		mockUuidToAnyDriveItem.set("dir-abc", decryptableItem("dir-abc", "My Folder"))

		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { uuid: "dir-abc" }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("My Folder")
	})

	it("drive: item in uuidToAnyDriveItem and undecryptable → driveItemDisplayName result", () => {
		const item = undecryptableItem("dir-xyz")

		mockUuidToAnyDriveItem.set("dir-xyz", item)

		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { uuid: "dir-xyz" }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(mockDriveItemDisplayName).toHaveBeenCalledWith(item)
		expect(result).toBe("display:dir-xyz")
	})

	it("drive: uuid not in any cache, stringifiedClientRootUuid mismatch → falls back to 'drive'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { uuid: "unknown-uuid" }),
			selectedCount: 0,
			stringifiedClientRootUuid: "other-root",
			t: t
		})

		expect(result).toBe("drive")
	})

	it("drive: uuid=null + no cache + no root match → falls back to 'drive'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { uuid: null }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("drive")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'trash' — always returns t("trash")
	// -------------------------------------------------------------------------

	it("trash: always returns 'trash' (no cache lookup)", () => {
		mockUuidToAnyDriveItem.set("trash-dir", decryptableItem("trash-dir", "should be ignored"))

		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("trash", { uuid: "trash-dir" }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("trash")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'recents'
	// -------------------------------------------------------------------------

	it("recents: always returns 'recents'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("recents"),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("recents")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'offline'
	// -------------------------------------------------------------------------

	it("offline: uuid in cache → cached name", () => {
		mockUuidToAnyDriveItem.set("offline-dir", decryptableItem("offline-dir", "Offline Folder"))

		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("offline", { uuid: "offline-dir" }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("Offline Folder")
	})

	it("offline: uuid not in cache → falls back to 'offline'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("offline", { uuid: "missing" }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("offline")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'sharedIn'
	// -------------------------------------------------------------------------

	it("sharedIn: uuid in cache → cached name (shared-dir rename now reflected)", () => {
		mockUuidToAnyDriveItem.set("shared-in-dir", decryptableItem("shared-in-dir", "SharedIn Folder"))

		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("sharedIn", { uuid: "shared-in-dir" }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("SharedIn Folder")
	})

	it("sharedIn: uuid not in cache → falls back to 'shared_with_me'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("sharedIn", { uuid: null }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("shared_with_me")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'sharedOut'
	// -------------------------------------------------------------------------

	it("sharedOut: falls back to 'shared_with_others'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("sharedOut", { uuid: null }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("shared_with_others")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'links'
	// -------------------------------------------------------------------------

	it("links: falls back to 'links'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("links", { uuid: null }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("links")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'favorites'
	// -------------------------------------------------------------------------

	it("favorites: falls back to 'favorites'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("favorites", { uuid: null }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("favorites")
	})

	// -------------------------------------------------------------------------
	// drivePath.type = 'linked'
	// -------------------------------------------------------------------------

	it("linked: linked.rootName present → rootName returned (no cache lookup)", () => {
		mockUuidToAnyDriveItem.set("linked-dir", decryptableItem("linked-dir", "should be ignored"))

		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("linked", {
				uuid: "linked-dir",
				linked: { uuid: "root", key: "k", rootName: "Root Folder Name" }
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("Root Folder Name")
	})

	it("linked: linked.rootName absent → cache lookup, then falls back to 'linked'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("linked", {
				uuid: null,
				linked: { uuid: "root", key: "k", rootName: "" }
			}),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("linked")
	})

	it("linked: no linked payload → falls back to 'linked'", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("linked", { uuid: null }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("linked")
	})

	// -------------------------------------------------------------------------
	// default / null type
	// -------------------------------------------------------------------------

	it("type=null (DrivePath with null type) → empty string", () => {
		const result = resolveDriveHeaderTitle({
			drivePath: { type: null, uuid: null } as DrivePath,
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		expect(result).toBe("")
	})

	// -------------------------------------------------------------------------
	// resolveBreadcrumb — a decryptable item in cache.uuidToAnyDriveItem resolves
	// to its decrypted name (never reaches the display-name / fallback branches)
	// -------------------------------------------------------------------------

	it("drive: item in uuidToAnyDriveItem and decryptable → its decrypted name (no fallback)", () => {
		mockUuidToAnyDriveItem.set("decryptable-dir", decryptableItem("decryptable-dir", "Decryptable"))

		const result = resolveDriveHeaderTitle({
			drivePath: drivePath("drive", { uuid: "decryptable-dir" }),
			selectedCount: 0,
			stringifiedClientRootUuid: null,
			t: t
		})

		// A decryptable cached item resolves to its decrypted name directly —
		// the display-name (undecryptable) branch is never reached.
		expect(mockDriveItemDisplayName).not.toHaveBeenCalled()
		expect(result).toBe("Decryptable")
	})
})

// ---------------------------------------------------------------------------
// rawUploadTimestamp — per-shape timestamp normalization (item-info rows)
// ---------------------------------------------------------------------------

describe("rawUploadTimestamp", () => {
	function makeItem(type: DriveItem["type"], data: Record<string, unknown>): DriveItem {
		return { type, data } as unknown as DriveItem
	}

	it("file → Number(data.timestamp)", () => {
		expect(rawUploadTimestamp(makeItem("file", { timestamp: 1700n }))).toBe(1700)
	})

	it("directory → Number(data.timestamp)", () => {
		expect(rawUploadTimestamp(makeItem("directory", { timestamp: 1800 }))).toBe(1800)
	})

	it("sharedFile → Number(data.timestamp)", () => {
		expect(rawUploadTimestamp(makeItem("sharedFile", { timestamp: 1900n }))).toBe(1900)
	})

	it("sharedRootFile → Number(data.timestamp)", () => {
		expect(rawUploadTimestamp(makeItem("sharedRootFile", { timestamp: 2000n }))).toBe(2000)
	})

	it("sharedDirectory → Number(data.inner.timestamp)", () => {
		expect(rawUploadTimestamp(makeItem("sharedDirectory", { inner: { timestamp: 2100n } }))).toBe(2100)
	})

	it("sharedRootDirectory → Number(data.inner.timestamp)", () => {
		expect(rawUploadTimestamp(makeItem("sharedRootDirectory", { inner: { timestamp: 2200 } }))).toBe(2200)
	})
})

// ---------------------------------------------------------------------------
// pickDisplayTimestamp — meta value vs upload-time fallback
// ---------------------------------------------------------------------------

describe("pickDisplayTimestamp", () => {
	it("returns the meta value (number) when truthy", () => {
		expect(pickDisplayTimestamp(1234, 9999)).toBe(1234)
	})

	it("returns the meta value (bigint, coerced) when truthy", () => {
		expect(pickDisplayTimestamp(1234n, 9999)).toBe(1234)
	})

	it("falls back to the upload timestamp when the meta value is undefined", () => {
		expect(pickDisplayTimestamp(undefined, 9999)).toBe(9999)
	})

	it("falls back to the upload timestamp when the meta value is null", () => {
		expect(pickDisplayTimestamp(null, 9999)).toBe(9999)
	})

	it("falls back when the meta value is 0 (preserves the original truthiness fallback)", () => {
		expect(pickDisplayTimestamp(0, 9999)).toBe(9999)
	})

	it("falls back when the meta value is 0n (the falsy-bigint case)", () => {
		expect(pickDisplayTimestamp(0n, 9999)).toBe(9999)
	})
})

// ---------------------------------------------------------------------------
// directorySizeTypeForDrivePath — DrivePath variant → size query mode
// ---------------------------------------------------------------------------

describe("directorySizeTypeForDrivePath", () => {
	it("sharedIn → sharedIn", () => {
		expect(directorySizeTypeForDrivePath("sharedIn")).toBe("sharedIn")
	})

	it("sharedOut → sharedOut", () => {
		expect(directorySizeTypeForDrivePath("sharedOut")).toBe("sharedOut")
	})

	it("trash → trash", () => {
		expect(directorySizeTypeForDrivePath("trash")).toBe("trash")
	})

	it("offline → offline (local index size, not remote)", () => {
		expect(directorySizeTypeForDrivePath("offline")).toBe("offline")
	})

	it("linked → linked", () => {
		expect(directorySizeTypeForDrivePath("linked")).toBe("linked")
	})

	it.each(["drive", "recents", "favorites", "links", "photos"] as const)("%s → normal", type => {
		expect(directorySizeTypeForDrivePath(type)).toBe("normal")
	})

	it("null → normal", () => {
		expect(directorySizeTypeForDrivePath(null)).toBe("normal")
	})

	it("undefined → normal", () => {
		expect(directorySizeTypeForDrivePath(undefined)).toBe("normal")
	})
})

// ---------------------------------------------------------------------------
// #9 — filterDriveItemsBySearchQuery: the SINGLE source of truth shared by the
// list body and the header's select-all / deselect-all toggle. With an active
// search this MUST narrow to the visible subset so select-all never targets
// search-hidden items; with no search it MUST pass the list through unchanged
// (so behavior is identical to the pre-fix unfiltered path).
// ---------------------------------------------------------------------------

describe("filterDriveItemsBySearchQuery", () => {
	beforeEach(() => {
		// Drive the display name off the item's decrypted name, falling back to the
		// cannot-decrypt placeholder for undecryptable items — mirroring the real
		// driveItemDisplayName so the filter's matching surface is realistic.
		mockDriveItemDisplayName.mockImplementation((item: unknown) => {
			const i = item as DriveItem

			if (i.data.undecryptable) {
				return `cannot_decrypt_${i.data.uuid}`
			}

			return i.data.decryptedMeta?.name ?? i.data.uuid
		})
	})

	function namedItem(uuid: string, name: string): DriveItem {
		return {
			type: "file",
			data: { uuid, undecryptable: false, decryptedMeta: { name } } as DriveItem["data"]
		} as DriveItem
	}

	const report = namedItem("a", "Report.pdf")
	const photo = namedItem("b", "Vacation Photo.jpg")
	const notes = namedItem("c", "report-notes.txt")
	const list = [report, photo, notes]

	it("empty query returns the list unchanged (same reference)", () => {
		expect(filterDriveItemsBySearchQuery(list, "")).toBe(list)
	})

	it("whitespace-only query returns the list unchanged (same reference)", () => {
		expect(filterDriveItemsBySearchQuery(list, "   ")).toBe(list)
	})

	it("matches case-insensitively across the display name", () => {
		expect(filterDriveItemsBySearchQuery(list, "REPORT")).toEqual([report, notes])
	})

	it("trims surrounding whitespace before matching", () => {
		expect(filterDriveItemsBySearchQuery(list, "  photo  ")).toEqual([photo])
	})

	it("returns an empty array when nothing matches (so select-all has nothing to select)", () => {
		expect(filterDriveItemsBySearchQuery(list, "zzz-no-match")).toEqual([])
	})

	it("preserves input order of the matched subset", () => {
		expect(filterDriveItemsBySearchQuery(list, ".")).toEqual([report, photo, notes])
	})

	it("undecryptable items remain searchable via the cannot_decrypt_<uuid> placeholder", () => {
		const broken = { type: "file", data: { uuid: "xyz", undecryptable: true, decryptedMeta: null } } as DriveItem

		expect(filterDriveItemsBySearchQuery([report, broken], "cannot_decrypt")).toEqual([broken])
		expect(filterDriveItemsBySearchQuery([report, broken], "xyz")).toEqual([broken])
	})

	it("the filtered subset is what select-all would receive — never the full list when a search is active", () => {
		// Models the header fix: selectAllItems(listItems) must equal the visible
		// rows, not every item in the directory.
		const visible = filterDriveItemsBySearchQuery(list, "report")

		expect(visible).toEqual([report, notes])
		expect(visible).not.toContain(photo)
	})
})
