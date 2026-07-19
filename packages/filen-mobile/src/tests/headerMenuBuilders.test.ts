import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ---- hoist mutable mocks so they are available inside vi.mock factories ----

const { mockIsItemStoredSync, mockIsItemTopLevelStoredSync, mockActionSheetShow } = vi.hoisted(() => ({
	mockIsItemStoredSync: vi.fn(),
	mockIsItemTopLevelStoredSync: vi.fn(),
	mockActionSheetShow: vi.fn()
}))

// ---- heavy native deps that must be stubbed before the module under test loads ----

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn(() => "mock-uuid") }))
vi.mock("expo-file-system", () => ({
	default: {},
	File: vi.fn(),
	Paths: { join: vi.fn() }
}))
vi.mock("expo-media-library/legacy", () => ({ saveToLibraryAsync: vi.fn() }))
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }))

vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/sort", () => ({}))
vi.mock("@/lib/serializer", () => ({ serialize: vi.fn(x => JSON.stringify(x)) }))
vi.mock("@/lib/bulkOps", () => ({ runBulk: vi.fn() }))
vi.mock("@/lib/tmp", () => ({ newTmpDir: vi.fn() }))
vi.mock("@/lib/sdkUnwrap", () => ({ getRealDriveItemParent: vi.fn() }))

vi.mock("@/components/ui/menu", () => ({}))

// buildSortMenuButton now delegates to buildSortFieldButton, which imports the actionSheet façade.
// Mock it so loading the builder doesn't pull the real provider (untranspilable native deps), and
// so the Android path's show() calls are observable.
vi.mock("@/providers/actionSheet.provider", () => ({ actionSheet: { show: mockActionSheetShow } }))

vi.mock("@/features/drive/drive", () => ({
	default: {
		restore: vi.fn(),
		deletePermanently: vi.fn(),
		trash: vi.fn(),
		favorite: vi.fn(),
		removeShare: vi.fn(),
		disablePublicLink: vi.fn(),
		shareWithFilenUser: vi.fn(),
		getRootUuid: vi.fn()
	}
}))

vi.mock("@/features/drive/store/useDrive.store", () => ({
	default: { getState: vi.fn(() => ({ clearSelectedItems: vi.fn() })) }
}))

vi.mock("@/features/drive/driveSelectors", () => ({}))
vi.mock("@/features/drive/driveDownload", () => ({ downloadDriveItemToDevice: vi.fn() }))

vi.mock("@/features/transfers/transfers", () => ({
	default: { download: vi.fn() }
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		isItemStoredSync: mockIsItemStoredSync,
		isItemTopLevelStoredSync: mockIsItemTopLevelStoredSync,
		storeFile: vi.fn(),
		storeDirectory: vi.fn(),
		removeItem: vi.fn()
	}
}))

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: vi.fn()
}))

vi.mock("@/features/contacts/contactsSelect", () => ({ selectContacts: vi.fn() }))

// ---- imports after mocks ----

import { buildSortMenuButton, buildBulkActionMenu, buildViewModeMenuButton } from "@/features/drive/components/headerMenuBuilders"
import { Platform } from "react-native"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import type { DriveSelectionFlags } from "@/features/drive/driveSelectors"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A t() stub that returns the key as-is for structural assertions. */
const t = (key: string) => key

function makeDrivePath(type: DrivePath["type"], uuid: string | null = null): DrivePath {
	return { type, uuid } as DrivePath
}

function makeFlags(overrides: Partial<DriveSelectionFlags> = {}): DriveSelectionFlags {
	return {
		count: 1,
		includesFavorited: false,
		everyFile: true,
		everyDirectory: false,
		everyImageOrVideoFile: false,
		includesUndecryptable: false,
		...overrides
	}
}

function makeFileItem(uuid = "file-1"): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			undecryptable: false,
			decryptedMeta: { name: "file.txt" }
		} as DriveItem["data"]
	} as DriveItem
}

function buttonIds(buttons: ReturnType<typeof buildBulkActionMenu>): string[] {
	return buttons.map(b => b.id)
}

// ---------------------------------------------------------------------------
// #32 — buildSortMenuButton checked-state and 6x2 leaf structure
// ---------------------------------------------------------------------------

describe("buildSortMenuButton", () => {
	it("returns a button with id='sort'", () => {
		const btn = buildSortMenuButton("nameAsc", vi.fn(), t as never)

		expect(btn.id).toBe("sort")
	})

	it("has exactly 6 top-level subButtons (groups)", () => {
		const btn = buildSortMenuButton("nameAsc", vi.fn(), t as never)

		expect(btn.subButtons).toHaveLength(6)
	})

	it("each group has exactly 2 leaf subButtons", () => {
		const btn = buildSortMenuButton("nameAsc", vi.fn(), t as never)

		for (const group of btn.subButtons ?? []) {
			expect((group.subButtons ?? []).length).toBe(2)
		}
	})

	it("leaf for current value has checked:true (nameAsc)", () => {
		const btn = buildSortMenuButton("nameAsc", vi.fn(), t as never)
		const nameGroup = btn.subButtons?.[0]
		const ascLeaf = nameGroup?.subButtons?.[0]

		expect(ascLeaf?.id).toBe("sort.nameAsc")
		expect(ascLeaf?.checked).toBe(true)
	})

	it("non-current leaves have checked:false (nameDesc when current=nameAsc)", () => {
		const btn = buildSortMenuButton("nameAsc", vi.fn(), t as never)
		const nameGroup = btn.subButtons?.[0]
		const descLeaf = nameGroup?.subButtons?.[1]

		expect(descLeaf?.id).toBe("sort.nameDesc")
		expect(descLeaf?.checked).toBe(false)
	})

	it("checked:true tracks the current value across different sort types (sizeDesc)", () => {
		const btn = buildSortMenuButton("sizeDesc", vi.fn(), t as never)
		const sizeGroup = btn.subButtons?.[1]
		const ascLeaf = sizeGroup?.subButtons?.[0]
		const descLeaf = sizeGroup?.subButtons?.[1]

		expect(ascLeaf?.checked).toBe(false)
		expect(descLeaf?.checked).toBe(true)
	})

	it("all other leaves are unchecked when current=nameAsc", () => {
		const btn = buildSortMenuButton("nameAsc", vi.fn(), t as never)

		// Flatten all leaf buttons across all 6 groups
		const allLeaves = (btn.subButtons ?? []).flatMap(g => g.subButtons ?? [])
		const checkedLeaves = allLeaves.filter(l => l.checked === true)

		// Only the nameAsc leaf should be checked
		expect(checkedLeaves).toHaveLength(1)
		expect(checkedLeaves[0]?.id).toBe("sort.nameAsc")
	})

	it("onPress of a leaf calls setSort with the correct SortByType value", () => {
		const setSort = vi.fn()
		const btn = buildSortMenuButton("nameAsc", setSort, t as never)
		const nameGroup = btn.subButtons?.[0]
		const descLeaf = nameGroup?.subButtons?.[1]

		descLeaf?.onPress?.()

		expect(setSort).toHaveBeenCalledTimes(1)
		expect(setSort).toHaveBeenCalledWith("nameDesc")
	})

	it("onPress of each leaf invokes setSort with its own value", () => {
		const setSort = vi.fn()
		const btn = buildSortMenuButton("nameAsc", setSort, t as never)

		// Press all 12 leaves and assert they each pass their own value
		const expectedValues = [
			"nameAsc",
			"nameDesc",
			"sizeAsc",
			"sizeDesc",
			"mimeAsc",
			"mimeDesc",
			"lastModifiedAsc",
			"lastModifiedDesc",
			"uploadDateAsc",
			"uploadDateDesc",
			"creationAsc",
			"creationDesc"
		]

		const allLeaves = (btn.subButtons ?? []).flatMap(g => g.subButtons ?? [])

		expect(allLeaves).toHaveLength(12)

		for (let i = 0; i < allLeaves.length; i++) {
			allLeaves[i]?.onPress?.()
			expect(setSort).toHaveBeenNthCalledWith(i + 1, expectedValues[i])
		}
	})
})

// ---------------------------------------------------------------------------
// buildSortMenuButton on Android — the 3rd menu level (direction) is collapsed
// into a direction ActionSheet, since @react-native-menu/menu can't nest a
// submenu inside a submenu. Fields stay in the menu as checkmarked leaves.
// ---------------------------------------------------------------------------

describe("buildSortMenuButton (Android)", () => {
	beforeEach(() => {
		mockActionSheetShow.mockClear()
		Platform.OS = "android"
	})

	afterEach(() => {
		Platform.OS = "ios"
	})

	it("keeps 6 fields but each is a leaf (no nested subButtons) with an onPress", () => {
		const btn = buildSortMenuButton("nameAsc", vi.fn(), t as never)

		expect(btn.subButtons).toHaveLength(6)

		for (const field of btn.subButtons ?? []) {
			expect("subButtons" in field).toBe(false)
			expect(typeof field.onPress).toBe("function")
		}
	})

	it("checkmarks the field that owns the current sort (size when current=sizeDesc)", () => {
		const btn = buildSortMenuButton("sizeDesc", vi.fn(), t as never)
		const nameField = btn.subButtons?.find(b => b.id === "sort.name")
		const sizeField = btn.subButtons?.find(b => b.id === "sort.size")

		expect(sizeField?.checked).toBe(true)
		expect(nameField?.checked).toBe(false)
	})

	it("tapping a field opens a titled direction ActionSheet with the current direction marked, routing setSort", () => {
		const setSort = vi.fn()
		const btn = buildSortMenuButton("nameAsc", setSort, t as never)
		const nameField = btn.subButtons?.find(b => b.id === "sort.name")

		nameField?.onPress?.()

		expect(mockActionSheetShow).toHaveBeenCalledTimes(1)

		const opts = mockActionSheetShow.mock.calls[0]?.[0]

		expect(opts.title).toBe("sort_name")
		expect(opts.buttons.map((b: { title: string }) => b.title)).toEqual(["sort_name_asc (current)", "sort_name_desc", "cancel"])

		// Picking "Descending" routes the right SortByType.
		opts.buttons[1].onPress()

		expect(setSort).toHaveBeenCalledTimes(1)
		expect(setSort).toHaveBeenCalledWith("nameDesc")
	})
})

// ---------------------------------------------------------------------------
// #31 — buildBulkActionMenu conditional button inclusion per type/flag
// ---------------------------------------------------------------------------

describe("buildBulkActionMenu", () => {
	const selectedItems = [makeFileItem()]
	const liveItems = [makeFileItem()]

	// Reset offline mocks before each test to avoid state leakage
	beforeEach(() => {
		mockIsItemStoredSync.mockReturnValue(false)
		mockIsItemTopLevelStoredSync.mockReturnValue(false)
	})

	// --- trash variant ---

	it("type='trash' returns exactly [restoreSelected, deleteSelectedPermanently]", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("trash"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toEqual(["restoreSelected", "deleteSelectedPermanently"])
	})

	it("type='trash' restoreSelected button has requiresOnline:true", () => {
		const buttons = buildBulkActionMenu({
			drivePath: makeDrivePath("trash"),
			selectedDriveItems: selectedItems,
			liveItems,
			driveFlags: makeFlags(),
			t: t as never
		})

		expect(buttons[0]?.requiresOnline).toBe(true)
	})

	it("type='trash' deleteSelectedPermanently button has destructive:true", () => {
		const buttons = buildBulkActionMenu({
			drivePath: makeDrivePath("trash"),
			selectedDriveItems: selectedItems,
			liveItems,
			driveFlags: makeFlags(),
			t: t as never
		})

		expect(buttons[1]?.destructive).toBe(true)
	})

	// --- favorite/unfavorite type gating ---

	it("type='drive' includes bulkFavorite", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesFavorited: false }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkFavorite")
	})

	it("type='recents' includes bulkFavorite", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("recents"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkFavorite")
	})

	it("type='favorites' includes bulkFavorite", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("favorites"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkFavorite")
	})

	it("type='sharedOut' includes bulkFavorite", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedOut"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkFavorite")
	})

	it("type='sharedIn' does NOT include bulkFavorite", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkFavorite")
	})

	it("type='links' does NOT include bulkFavorite", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("links"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkFavorite")
	})

	it("includesFavorited=true → bulkFavorite title is 'unfavorite_selected'", () => {
		const buttons = buildBulkActionMenu({
			drivePath: makeDrivePath("drive"),
			selectedDriveItems: selectedItems,
			liveItems,
			driveFlags: makeFlags({ includesFavorited: true }),
			t: t as never
		})
		const favoriteBtn = buttons.find(b => b.id === "bulkFavorite")

		expect(favoriteBtn?.title).toBe("unfavorite_selected")
	})

	it("includesFavorited=false → bulkFavorite title is 'favorite_selected'", () => {
		const buttons = buildBulkActionMenu({
			drivePath: makeDrivePath("drive"),
			selectedDriveItems: selectedItems,
			liveItems,
			driveFlags: makeFlags({ includesFavorited: false }),
			t: t as never
		})
		const favoriteBtn = buttons.find(b => b.id === "bulkFavorite")

		expect(favoriteBtn?.title).toBe("favorite_selected")
	})

	// --- move type gating ---

	it("type='drive' includes bulkMove", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkMove")
	})

	it("type='sharedIn' does NOT include bulkMove", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkMove")
	})

	it("type='offline' does NOT include bulkMove", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("offline"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkMove")
	})

	// --- download type gating ---

	it("type='drive' includes bulkDownload", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkDownload")
	})

	it("type='sharedIn' includes bulkDownload", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkDownload")
	})

	it("type='offline' does NOT include bulkDownload", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("offline"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkDownload")
	})

	// --- saveToPhotos gating ---

	it("everyImageOrVideoFile=false → no bulkSaveToPhotos", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ everyImageOrVideoFile: false }),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkSaveToPhotos")
	})

	it("everyImageOrVideoFile=true + type='drive' → includes bulkSaveToPhotos", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ everyImageOrVideoFile: true }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkSaveToPhotos")
	})

	it("everyImageOrVideoFile=true + type='sharedOut' → no bulkSaveToPhotos (type not in allowed set)", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedOut"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ everyImageOrVideoFile: true }),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkSaveToPhotos")
	})

	it("everyImageOrVideoFile=true + type='sharedIn' → no bulkSaveToPhotos", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ everyImageOrVideoFile: true }),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkSaveToPhotos")
	})

	// --- stopSharing isAtRoot gating ---

	it("type='sharedOut' + isAtRoot (uuid=null) → includes bulkStopSharing", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedOut", null),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkStopSharing")
	})

	it("type='sharedOut' + !isAtRoot (uuid set) → no bulkStopSharing", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedOut", "some-uuid"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkStopSharing")
	})

	it("type='drive' → never includes bulkStopSharing", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkStopSharing")
	})

	// --- removeShare isAtRoot gating ---

	it("type='sharedIn' + isAtRoot (uuid=null) → includes bulkRemoveShare", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn", null),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkRemoveShare")
	})

	it("type='sharedIn' + !isAtRoot (uuid set) → no bulkRemoveShare", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn", "sub-uuid"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkRemoveShare")
	})

	// --- disablePublicLink isAtRoot gating ---

	it("type='links' + isAtRoot (uuid=null) → includes bulkDisablePublicLink", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("links", null),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkDisablePublicLink")
	})

	it("type='links' + !isAtRoot (uuid set) → no bulkDisablePublicLink", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("links", "sub-uuid"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkDisablePublicLink")
	})

	// --- makeOffline gating (everySelectedKnownStoredOffline) ---

	it("type='drive' + everySelectedKnownStoredOffline=true → no bulkMakeOffline", () => {
		mockIsItemStoredSync.mockReturnValue(true)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkMakeOffline")
	})

	it("type='drive' + everySelectedKnownStoredOffline=false → includes bulkMakeOffline", () => {
		mockIsItemStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkMakeOffline")
	})

	it("type='drive' + isItemStoredSync=undefined → includes bulkMakeOffline (fallback to show)", () => {
		// When the cache hasn't been populated (undefined), every().===true is false
		// so bulkMakeOffline is shown (safe fallback)
		mockIsItemStoredSync.mockReturnValue(undefined)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkMakeOffline")
	})

	it("type='sharedIn' → includes bulkMakeOffline (shared items are offline-capable)", () => {
		// Bulk Make-offline must be available in Shared With You, matching single-item behavior — the
		// offline lib fully supports shared items. getRealDriveItemParent is mocked non-null (parents
		// resolve) and items aren't all stored, so the action shows.
		mockIsItemStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkMakeOffline")
	})

	// --- removeOffline gating (anySelectedTopLevelOffline) ---

	it("type='drive' + anySelectedTopLevelOffline=true → includes bulkRemoveOffline", () => {
		mockIsItemTopLevelStoredSync.mockReturnValue(true)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkRemoveOffline")
	})

	it("type='drive' + anySelectedTopLevelOffline=false → no bulkRemoveOffline", () => {
		mockIsItemTopLevelStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkRemoveOffline")
	})

	it("type='offline' + isAtRoot (uuid=null) → includes bulkRemoveOffline unconditionally", () => {
		mockIsItemTopLevelStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("offline", null),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkRemoveOffline")
	})

	it("type='offline' + !isAtRoot (uuid set) → no bulkRemoveOffline", () => {
		mockIsItemTopLevelStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("offline", "child-uuid"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkRemoveOffline")
	})

	it("bulkRemoveOffline is destructive:true", () => {
		mockIsItemTopLevelStoredSync.mockReturnValue(true)

		const buttons = buildBulkActionMenu({
			drivePath: makeDrivePath("drive"),
			selectedDriveItems: selectedItems,
			liveItems,
			driveFlags: makeFlags(),
			t: t as never
		})
		const removeOfflineBtn = buttons.find(b => b.id === "bulkRemoveOffline")

		expect(removeOfflineBtn?.destructive).toBe(true)
	})

	// --- trash button gating ---

	it("type='drive' includes bulkTrash", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkTrash")
	})

	it("type='sharedIn' does NOT include bulkTrash", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkTrash")
	})

	it("type='offline' does NOT include bulkTrash", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("offline"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkTrash")
	})

	// --- shareFilenUser gating ---

	it("type='drive' includes bulkShareFilenUser", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).toContain("bulkShareFilenUser")
	})

	it("type='sharedIn' does NOT include bulkShareFilenUser", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags(),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkShareFilenUser")
	})

	// --- overall button-ordering sanity for drive variant ---

	it("type='drive' button order: bulkFavorite, bulkMove, bulkDownload, bulkShareFilenUser, bulkMakeOffline, bulkTrash", () => {
		mockIsItemStoredSync.mockReturnValue(false)
		mockIsItemTopLevelStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ everyImageOrVideoFile: false }),
				t: t as never
			})
		)

		expect(ids).toEqual(["bulkFavorite", "bulkMove", "bulkDownload", "bulkShareFilenUser", "bulkMakeOffline", "bulkTrash"])
	})

	// --- #28: includesUndecryptable gates meta-requiring bulk ops ---

	it("includesUndecryptable=true + type='drive' suppresses all meta-requiring actions", () => {
		mockIsItemStoredSync.mockReturnValue(false)
		mockIsItemTopLevelStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesUndecryptable: true, everyImageOrVideoFile: true }),
				t: t as never
			})
		)

		expect(ids).not.toContain("bulkFavorite")
		expect(ids).not.toContain("bulkMove")
		expect(ids).not.toContain("bulkDownload")
		expect(ids).not.toContain("bulkSaveToPhotos")
		expect(ids).not.toContain("bulkShareFilenUser")
		expect(ids).not.toContain("bulkMakeOffline")
	})

	it("includesUndecryptable=true + type='drive' still offers bulkTrash (pure-uuid disposition)", () => {
		mockIsItemStoredSync.mockReturnValue(false)
		mockIsItemTopLevelStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesUndecryptable: true }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkTrash")
	})

	it("includesUndecryptable=true + type='drive' + anyTopLevelOffline still offers bulkRemoveOffline", () => {
		mockIsItemStoredSync.mockReturnValue(false)
		mockIsItemTopLevelStoredSync.mockReturnValue(true)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesUndecryptable: true }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkRemoveOffline")
	})

	it("includesUndecryptable=true + type='sharedOut' + isAtRoot still offers bulkStopSharing", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedOut", null),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesUndecryptable: true }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkStopSharing")
		expect(ids).not.toContain("bulkFavorite")
		expect(ids).not.toContain("bulkDownload")
		expect(ids).not.toContain("bulkShareFilenUser")
	})

	it("includesUndecryptable=true + type='sharedIn' + isAtRoot still offers bulkRemoveShare", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("sharedIn", null),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesUndecryptable: true }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkRemoveShare")
		expect(ids).not.toContain("bulkDownload")
	})

	it("includesUndecryptable=true + type='links' + isAtRoot still offers bulkDisablePublicLink", () => {
		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("links", null),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesUndecryptable: true }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkDisablePublicLink")
		expect(ids).not.toContain("bulkDownload")
		expect(ids).not.toContain("bulkMove")
	})

	it("includesUndecryptable=false (all decryptable) → meta-requiring actions appear as normal", () => {
		mockIsItemStoredSync.mockReturnValue(false)
		mockIsItemTopLevelStoredSync.mockReturnValue(false)

		const ids = buttonIds(
			buildBulkActionMenu({
				drivePath: makeDrivePath("drive"),
				selectedDriveItems: selectedItems,
				liveItems,
				driveFlags: makeFlags({ includesUndecryptable: false }),
				t: t as never
			})
		)

		expect(ids).toContain("bulkFavorite")
		expect(ids).toContain("bulkMove")
		expect(ids).toContain("bulkDownload")
		expect(ids).toContain("bulkShareFilenUser")
		expect(ids).toContain("bulkMakeOffline")
		expect(ids).toContain("bulkTrash")
	})
})

// ---------------------------------------------------------------------------
// buildViewModeMenuButton — depth-2 "View" submenu (Android-safe)
// ---------------------------------------------------------------------------

describe("buildViewModeMenuButton", () => {
	it("returns a 'viewMode' submenu with list + grid leaves (depth 2, Android-safe)", () => {
		const btn = buildViewModeMenuButton("list", vi.fn(), t as never)

		expect(btn.id).toBe("viewMode")
		expect(btn.subButtons).toHaveLength(2)
		const ids = (btn.subButtons ?? []).map(b => b.id)
		expect(ids).toEqual(["viewMode.list", "viewMode.grid"])
		// leaves are not themselves submenus (depth stays 2)
		for (const leaf of btn.subButtons ?? []) {
			expect("subButtons" in leaf).toBe(false)
		}
	})

	it("checkmarks the current mode", () => {
		const grid = buildViewModeMenuButton("grid", vi.fn(), t as never)
		expect(grid.subButtons?.find(b => b.id === "viewMode.grid")?.checked).toBe(true)
		expect(grid.subButtons?.find(b => b.id === "viewMode.list")?.checked).toBe(false)
	})

	it("each leaf's onPress sets its mode", () => {
		const setViewMode = vi.fn()
		const btn = buildViewModeMenuButton("list", setViewMode, t as never)
		btn.subButtons?.find(b => b.id === "viewMode.grid")?.onPress?.()
		expect(setViewMode).toHaveBeenCalledWith("grid")
	})
})
