import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockRouterPush } = vi.hoisted(() => ({
	mockRouterPush: vi.fn()
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-router", () => ({
	router: {
		push: mockRouterPush
	}
}))

vi.mock("@/lib/router", () => ({
	router: {
		push: mockRouterPush
	}
}))

vi.mock("@/lib/utils", () => ({}))

// Use the real implementation so the mock cannot silently drift from production behaviour.
// @/constants is extended below to supply the extension Sets that the real getPreviewType reads.
vi.mock("@/lib/previewType", async () => vi.importActual("@/lib/previewType"))

// Extend the shared constants mock with the extension Sets that @/lib/previewType requires.
// Values are derived from the iOS Platform.select arm (Platform.OS = 'ios' in the RN mock).
vi.mock("@/constants", async () => {
	const base = await import("@/tests/mocks/constants")

	return {
		...base,
		EXPO_IMAGE_SUPPORTED_EXTENSIONS: new Set([
			".jpg",
			".jpeg",
			".png",
			".gif",
			".webp",
			".avif",
			".heic",
			".heif",
			".svg",
			".ico",
			".icns"
		]),
		EXPO_AUDIO_SUPPORTED_EXTENSIONS: new Set([".mp3", ".m4a", ".aac", ".wav", ".aiff", ".caf", ".flac", ".alac"])
	}
})
vi.mock("@filen/sdk-rs", () => ({}))

import { useDrivePreviewStore } from "@/stores/useDrivePreview.store"
import { useCameraUploadStore, MAX_CAMERA_UPLOAD_ERRORS } from "@/features/cameraUpload/store/useCameraUpload.store"
import { useContactsStore } from "@/features/contacts/store/useContacts.store"
import { useHttpStore } from "@/stores/useHttp.store"
import { useAppStore } from "@/stores/useApp.store"
import type { GalleryItemTagged, InitialItem } from "@/components/drivePreview/gallery"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"
import type { ContactListItem } from "@/features/contacts/store/useContacts.store"
import type { AnyFile } from "@filen/sdk-rs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDrivePath(type: DrivePathType = "drive"): DrivePath {
	return { type, uuid: "root-uuid" }
}

/**
 * Build a minimal DriveItemFileExtracted-shaped GalleryItemTagged of type "drive".
 * The `name` determines which previewType the filtering logic assigns.
 */
function makeDriveGalleryItem(uuid: string, name: string): GalleryItemTagged {
	return {
		type: "drive",
		data: {
			type: "file",
			data: {
				uuid,
				decryptedMeta: { name, size: 0n } as never,
				size: 0n,
				undecryptable: false
			} as never
		}
	} as GalleryItemTagged
}

function makeInitialDriveItem(uuid: string, name: string, drivePath: DrivePath = makeDrivePath()): InitialItem {
	return {
		type: "drive",
		data: {
			item: makeDriveGalleryItem(uuid, name).data as never,
			drivePath
		}
	}
}

function makeInitialExternalItem(): InitialItem {
	return {
		type: "external",
		data: { uri: "file:///tmp/ext.jpg", name: "ext.jpg", mimeType: "image/jpeg" } as never
	}
}

function resetDrivePreviewStore(): void {
	useDrivePreviewStore.setState({
		headerHeight: null,
		currentItem: null,
		currentIndex: null,
		items: [],
		initialScrollIndex: 0,
		drivePath: null
	})
}

function resetCameraUploadStore(): void {
	useCameraUploadStore.setState({ syncing: false, errors: [], skippedAssets: new Set<string>() })
}

function resetContactsStore(): void {
	useContactsStore.setState({ selectedContacts: [], bulkMode: false })
}

function resetHttpStore(): void {
	useHttpStore.setState({ port: null, getFileUrl: null })
}

function resetAppStore(): void {
	useAppStore.setState({ pathname: "/", biometricUnlocked: null })
}

// ---------------------------------------------------------------------------
// useDrivePreviewStore — reset()
// ---------------------------------------------------------------------------

describe("useDrivePreviewStore.reset", () => {
	beforeEach(() => {
		resetDrivePreviewStore()
		mockRouterPush.mockClear()
	})

	it("resets currentIndex, currentItem, items, initialScrollIndex, drivePath to their initial values", () => {
		// Pre-populate store with non-default state
		useDrivePreviewStore.setState({
			currentIndex: 2,
			currentItem: makeDriveGalleryItem("img1", "photo.jpg"),
			items: [makeDriveGalleryItem("img1", "photo.jpg"), makeDriveGalleryItem("img2", "photo2.jpg")],
			initialScrollIndex: 2,
			drivePath: makeDrivePath("photos")
		})

		useDrivePreviewStore.getState().reset()

		const state = useDrivePreviewStore.getState()

		expect(state.currentIndex).toBeNull()
		expect(state.currentItem).toBeNull()
		expect(state.items).toEqual([])
		expect(state.initialScrollIndex).toBe(0)
		expect(state.drivePath).toBeNull()
	})

	it("does NOT clear headerHeight — it survives reset()", () => {
		useDrivePreviewStore.setState({ headerHeight: 88 })

		useDrivePreviewStore.getState().reset()

		expect(useDrivePreviewStore.getState().headerHeight).toBe(88)
	})
})

// ---------------------------------------------------------------------------
// useDrivePreviewStore — open()
// ---------------------------------------------------------------------------

describe("useDrivePreviewStore.open", () => {
	beforeEach(() => {
		resetDrivePreviewStore()
		mockRouterPush.mockClear()
	})

	it("is a no-op when currentIndex is already non-null", () => {
		useDrivePreviewStore.setState({ currentIndex: 0 })

		const items = [makeDriveGalleryItem("img1", "photo.jpg")]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialDriveItem("img1", "photo.jpg") })

		// The router should not be called — already open guard fired
		expect(mockRouterPush).not.toHaveBeenCalled()
		// State should be unchanged from what was set before
		expect(useDrivePreviewStore.getState().items).toEqual([])
	})

	it("is a no-op when currentItem is already non-null", () => {
		useDrivePreviewStore.setState({ currentItem: makeDriveGalleryItem("img1", "photo.jpg") })

		const items = [makeDriveGalleryItem("img2", "other.jpg")]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialDriveItem("img2", "other.jpg") })

		expect(mockRouterPush).not.toHaveBeenCalled()
		// items not overwritten
		expect(useDrivePreviewStore.getState().items).toEqual([])
	})

	it("for initialItem.type='external', itemsFiltered is a single-element array and router.push is called", () => {
		const items = [makeDriveGalleryItem("img1", "photo.jpg"), makeDriveGalleryItem("img2", "other.jpg")]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialExternalItem() })

		const state = useDrivePreviewStore.getState()

		expect(state.items).toHaveLength(1)
		expect(state.items[0]?.type).toBe("external")
		expect(state.initialScrollIndex).toBe(0)
		expect(state.currentIndex).toBe(0)
		expect(mockRouterPush).toHaveBeenCalledWith("/drivePreview")
	})

	it("for a text file, itemsFiltered is a single-element array containing only that file", () => {
		const docItem = makeDriveGalleryItem("doc1", "readme.txt")
		const imgItem = makeDriveGalleryItem("img1", "photo.jpg")
		const items: GalleryItemTagged[] = [imgItem, docItem]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialDriveItem("doc1", "readme.txt") })

		const state = useDrivePreviewStore.getState()

		expect(state.items).toHaveLength(1)
		expect(state.items[0]?.type).toBe("drive")
		expect((state.items[0] as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid).toBe("doc1")
	})

	it("for a pdf file, itemsFiltered is a single-element array containing only that file", () => {
		const pdfItem = makeDriveGalleryItem("pdf1", "document.pdf")
		const imgItem = makeDriveGalleryItem("img1", "photo.jpg")
		const items: GalleryItemTagged[] = [imgItem, pdfItem]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialDriveItem("pdf1", "document.pdf") })

		const state = useDrivePreviewStore.getState()

		expect(state.items).toHaveLength(1)
		expect((state.items[0] as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid).toBe("pdf1")
	})

	it("for a code file, itemsFiltered is a single-element array containing only that file", () => {
		const codeItem = makeDriveGalleryItem("code1", "main.ts")
		const items: GalleryItemTagged[] = [codeItem, makeDriveGalleryItem("img1", "photo.jpg")]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialDriveItem("code1", "main.ts") })

		const state = useDrivePreviewStore.getState()

		expect(state.items).toHaveLength(1)
		expect((state.items[0] as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid).toBe("code1")
	})

	it("for a docx file, itemsFiltered is a single-element array containing only that file", () => {
		const docxItem = makeDriveGalleryItem("docx1", "report.docx")
		const items: GalleryItemTagged[] = [docxItem, makeDriveGalleryItem("img1", "photo.jpg")]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialDriveItem("docx1", "report.docx") })

		const state = useDrivePreviewStore.getState()

		expect(state.items).toHaveLength(1)
		expect((state.items[0] as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid).toBe("docx1")
	})

	it("for drivePath.type='photos', only image+video items with displayable image extensions survive", () => {
		const photosDrivePath = makeDrivePath("photos")
		// The photos filter uses EXPO_IMAGE_SUPPORTED_EXTENSIONS (the displayable set),
		// which includes .gif — expo-image renders gifs, so they belong in the gallery (#48).
		const items: GalleryItemTagged[] = [
			makeDriveGalleryItem("img1", "photo.jpg"), // image + displayable ext → included
			makeDriveGalleryItem("img2", "photo.gif"), // image + displayable ext (gif) → included
			makeDriveGalleryItem("vid1", "clip.mp4"), // video → included
			makeDriveGalleryItem("aud1", "track.mp3"), // audio → excluded
			makeDriveGalleryItem("doc1", "readme.txt") // text → excluded
		]

		useDrivePreviewStore.getState().open({
			items,
			initialItem: makeInitialDriveItem("img1", "photo.jpg", photosDrivePath)
		})

		const state = useDrivePreviewStore.getState()
		const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

		expect(uuids).toContain("img1")
		expect(uuids).toContain("vid1")
		expect(uuids).not.toContain("aud1")
		expect(uuids).not.toContain("doc1")
		// .gif IS displayable (EXPO_IMAGE_SUPPORTED_EXTENSIONS) → included in the gallery (#48)
		expect(uuids).toContain("img2")
	})

	it("for a general drive path, audio files are included but docx/pdf/code files are excluded", () => {
		const items: GalleryItemTagged[] = [
			makeDriveGalleryItem("img1", "photo.jpg"), // image → included
			makeDriveGalleryItem("vid1", "clip.mp4"), // video → included
			makeDriveGalleryItem("aud1", "track.mp3"), // audio → included
			makeDriveGalleryItem("pdf1", "doc.pdf"), // pdf → excluded
			makeDriveGalleryItem("code1", "main.ts"), // code → excluded
			makeDriveGalleryItem("docx1", "report.docx") // docx → excluded
		]

		useDrivePreviewStore.getState().open({
			items,
			initialItem: makeInitialDriveItem("img1", "photo.jpg", makeDrivePath("drive"))
		})

		const state = useDrivePreviewStore.getState()
		const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

		expect(uuids).toContain("img1")
		expect(uuids).toContain("vid1")
		expect(uuids).toContain("aud1")
		expect(uuids).not.toContain("pdf1")
		expect(uuids).not.toContain("code1")
		expect(uuids).not.toContain("docx1")
	})

	it("returns without setting state when initialItem uuid is not found in itemsFiltered", () => {
		// Only an audio item in items; initial item uuid is 'missing'
		const items: GalleryItemTagged[] = [makeDriveGalleryItem("img1", "photo.jpg")]

		// initialItem refers to 'missing' which is not in items
		useDrivePreviewStore.getState().open({
			items,
			initialItem: makeInitialDriveItem("missing", "photo.jpg")
		})

		const state = useDrivePreviewStore.getState()

		// Nothing should have been set — findIndex returned -1, initItem was undefined
		expect(state.currentItem).toBeNull()
		expect(state.currentIndex).toBeNull()
		expect(mockRouterPush).not.toHaveBeenCalled()
	})

	it("calls reset() before set(), so stale items from prior open are cleared before new state is written", () => {
		// First open
		const itemsFirst = [makeDriveGalleryItem("img1", "photo.jpg")]

		useDrivePreviewStore.getState().open({
			items: itemsFirst,
			initialItem: makeInitialDriveItem("img1", "photo.jpg")
		})

		// Manually clear the open-guard fields to simulate gallery teardown
		useDrivePreviewStore.setState({ currentIndex: null, currentItem: null })

		// Second open with different items
		const itemsSecond = [makeDriveGalleryItem("img2", "second.jpg"), makeDriveGalleryItem("img3", "third.jpg")]

		useDrivePreviewStore.getState().open({
			items: itemsSecond,
			initialItem: makeInitialDriveItem("img2", "second.jpg")
		})

		const state = useDrivePreviewStore.getState()

		// Items from first open must NOT appear in the second open's items
		const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

		expect(uuids).not.toContain("img1")
		expect(uuids).toContain("img2")
		expect(uuids).toContain("img3")
	})

	it("sets currentItem to the item at initialScrollIndex after a successful open", () => {
		const items: GalleryItemTagged[] = [
			makeDriveGalleryItem("img1", "first.jpg"),
			makeDriveGalleryItem("img2", "second.jpg"),
			makeDriveGalleryItem("img3", "third.jpg")
		]

		// Open with img2 as the initial item
		useDrivePreviewStore.getState().open({
			items,
			initialItem: makeInitialDriveItem("img2", "second.jpg")
		})

		const state = useDrivePreviewStore.getState()

		expect(state.currentIndex).toBe(1)
		expect(state.initialScrollIndex).toBe(1)
		expect(state.currentItem).toBeDefined()
		expect((state.currentItem as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid).toBe("img2")
		expect(mockRouterPush).toHaveBeenCalledWith("/drivePreview")
	})

	it("is fully idempotent: calling open twice does not change state after the first call", () => {
		const items: GalleryItemTagged[] = [makeDriveGalleryItem("img1", "photo.jpg")]

		useDrivePreviewStore.getState().open({ items, initialItem: makeInitialDriveItem("img1", "photo.jpg") })

		const stateAfterFirst = { ...useDrivePreviewStore.getState() }

		// Try to call open again with different items (should be a no-op)
		const newItems: GalleryItemTagged[] = [makeDriveGalleryItem("img2", "other.jpg"), makeDriveGalleryItem("img3", "third.jpg")]

		useDrivePreviewStore.getState().open({ items: newItems, initialItem: makeInitialDriveItem("img2", "other.jpg") })

		const stateAfterSecond = useDrivePreviewStore.getState()

		expect(stateAfterSecond.currentItem).toEqual(stateAfterFirst.currentItem)
		expect(stateAfterSecond.currentIndex).toBe(stateAfterFirst.currentIndex)
		expect(stateAfterSecond.items).toHaveLength(1)
		// router.push called exactly once
		expect(mockRouterPush).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// useCameraUploadStore — addSkippedAsset / clearSkippedAssets
// ---------------------------------------------------------------------------

describe("useCameraUploadStore.addSkippedAsset", () => {
	beforeEach(() => {
		resetCameraUploadStore()
	})

	it("adds an id that was not previously in the set", () => {
		useCameraUploadStore.getState().addSkippedAsset("asset-1")

		expect(useCameraUploadStore.getState().skippedAssets.has("asset-1")).toBe(true)
	})

	it("calling twice with same id does not duplicate (Set dedup)", () => {
		useCameraUploadStore.getState().addSkippedAsset("asset-1")
		useCameraUploadStore.getState().addSkippedAsset("asset-1")

		expect(useCameraUploadStore.getState().skippedAssets.size).toBe(1)
	})

	it("returns a new Set instance each time — old reference is not mutated", () => {
		const before = useCameraUploadStore.getState().skippedAssets

		useCameraUploadStore.getState().addSkippedAsset("asset-1")

		const after = useCameraUploadStore.getState().skippedAssets

		expect(after).not.toBe(before)
	})

	it("clearSkippedAssets resets to an empty Set", () => {
		useCameraUploadStore.getState().addSkippedAsset("asset-1")
		useCameraUploadStore.getState().addSkippedAsset("asset-2")
		useCameraUploadStore.getState().clearSkippedAssets()

		expect(useCameraUploadStore.getState().skippedAssets.size).toBe(0)
	})

	it("after clearSkippedAssets, previously added ids are no longer present", () => {
		useCameraUploadStore.getState().addSkippedAsset("asset-1")
		useCameraUploadStore.getState().clearSkippedAssets()

		expect(useCameraUploadStore.getState().skippedAssets.has("asset-1")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// useCameraUploadStore.setErrors — bounded error log (CU-08)
// ---------------------------------------------------------------------------

describe("useCameraUploadStore.setErrors — bounded error log (CU-08)", () => {
	beforeEach(() => {
		resetCameraUploadStore()
	})

	function makeErrors(count: number, startIndex = 0): { id: string; timestamp: number }[] {
		const errors: { id: string; timestamp: number }[] = []

		for (let i = 0; i < count; i++) {
			errors.push({ id: `e${startIndex + i}`, timestamp: startIndex + i })
		}

		return errors
	}

	it("stores an array under the cap unchanged", () => {
		useCameraUploadStore.getState().setErrors(makeErrors(3))

		expect(useCameraUploadStore.getState().errors.length).toBe(3)
	})

	it("caps a direct set at MAX_CAMERA_UPLOAD_ERRORS", () => {
		useCameraUploadStore.getState().setErrors(makeErrors(MAX_CAMERA_UPLOAD_ERRORS + 50))

		expect(useCameraUploadStore.getState().errors.length).toBe(MAX_CAMERA_UPLOAD_ERRORS)
	})

	it("keeps the MOST RECENT entries and drops the oldest (front) when over the cap", () => {
		useCameraUploadStore.getState().setErrors(makeErrors(MAX_CAMERA_UPLOAD_ERRORS + 5))

		const errors = useCameraUploadStore.getState().errors

		// The 5 oldest were dropped from the front; the newest is retained at the back.
		expect(errors[0]?.id).toBe("e5")
		expect(errors[errors.length - 1]?.id).toBe(`e${MAX_CAMERA_UPLOAD_ERRORS + 4}`)
	})

	it("functional append (the engine's per-pass push) stays bounded across many passes", () => {
		// Simulate a durable failure pushing one entry per sync pass, far beyond the cap — the
		// unbounded-growth bug. The array must stabilize at the cap, not grow forever.
		for (let pass = 0; pass < MAX_CAMERA_UPLOAD_ERRORS + 30; pass++) {
			useCameraUploadStore.getState().setErrors(errors => [...errors, { id: `e${pass}`, timestamp: pass }])
		}

		const errors = useCameraUploadStore.getState().errors

		expect(errors.length).toBe(MAX_CAMERA_UPLOAD_ERRORS)
		// The most recent push is still present at the back.
		expect(errors[errors.length - 1]?.id).toBe(`e${MAX_CAMERA_UPLOAD_ERRORS + 29}`)
	})
})

// ---------------------------------------------------------------------------
// useContactsStore — clearSelectedContacts + contactItemId semantics
// ---------------------------------------------------------------------------

function makeContact(uuid: string, type: "contact" | "blocked"): ContactListItem {
	return {
		type,
		data: { uuid, email: `${uuid}@example.com`, nickName: "" } as never
	}
}

describe("useContactsStore.clearSelectedContacts", () => {
	beforeEach(() => {
		resetContactsStore()
	})

	it("empties selectedContacts to []", () => {
		useContactsStore.getState().toggleSelectedContact(makeContact("c1", "contact"))
		useContactsStore.getState().clearSelectedContacts()

		expect(useContactsStore.getState().selectedContacts).toEqual([])
	})

	it("resets bulkMode to false even when it was true", () => {
		useContactsStore.getState().setBulkMode(true)
		useContactsStore.getState().clearSelectedContacts()

		expect(useContactsStore.getState().bulkMode).toBe(false)
	})

	it("selectAllContacts does NOT reset bulkMode — only clearSelectedContacts does", () => {
		useContactsStore.getState().setBulkMode(true)
		useContactsStore.getState().selectAllContacts([makeContact("c1", "contact")])

		// bulkMode should remain true since selectAllContacts doesn't touch it
		expect(useContactsStore.getState().bulkMode).toBe(true)
	})
})

describe("useContactsStore — contactItemId semantics via toggleSelectedContact", () => {
	beforeEach(() => {
		resetContactsStore()
	})

	it("same uuid of different types are both retained when toggled independently", () => {
		const asContact = makeContact("user-1", "contact")
		const asBlocked = makeContact("user-1", "blocked")

		useContactsStore.getState().toggleSelectedContact(asContact)
		useContactsStore.getState().toggleSelectedContact(asBlocked)

		const selected = useContactsStore.getState().selectedContacts

		expect(selected).toHaveLength(2)
		expect(selected.some(i => i.type === "contact" && i.data.uuid === "user-1")).toBe(true)
		expect(selected.some(i => i.type === "blocked" && i.data.uuid === "user-1")).toBe(true)
	})

	it("two items with same type and same uuid are treated as duplicates — removes on second toggle", () => {
		const item = makeContact("user-1", "contact")

		useContactsStore.getState().toggleSelectedContact(item)

		expect(useContactsStore.getState().selectedContacts).toHaveLength(1)

		// Toggle same item again — should remove it
		useContactsStore.getState().toggleSelectedContact(item)

		expect(useContactsStore.getState().selectedContacts).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// useHttpStore — setGetFileUrl
// ---------------------------------------------------------------------------

describe("useHttpStore.setGetFileUrl", () => {
	beforeEach(() => {
		resetHttpStore()
	})

	it("initial state: port is null and getFileUrl is null", () => {
		const state = useHttpStore.getState()

		expect(state.port).toBeNull()
		expect(state.getFileUrl).toBeNull()
	})

	it("setGetFileUrl(fn) stores the function", () => {
		const fn = (_file: AnyFile) => "http://localhost:8080/file"

		useHttpStore.getState().setGetFileUrl(fn)

		expect(useHttpStore.getState().getFileUrl).toBe(fn)
	})

	it("setGetFileUrl(null) clears a previously set function back to null", () => {
		useHttpStore.getState().setGetFileUrl((_file: AnyFile) => "http://localhost:8080/file")
		useHttpStore.getState().setGetFileUrl(null)

		expect(useHttpStore.getState().getFileUrl).toBeNull()
	})

	it("setPort with a functional updater correctly updates port from previous value", () => {
		useHttpStore.getState().setPort(3000)

		expect(useHttpStore.getState().port).toBe(3000)

		useHttpStore.getState().setPort(prev => (prev ?? 0) + 1)

		expect(useHttpStore.getState().port).toBe(3001)
	})
})

// ---------------------------------------------------------------------------
// useAppStore — setPathname (plain string + functional-updater branches)
// ---------------------------------------------------------------------------

describe("useAppStore.setPathname", () => {
	beforeEach(() => {
		resetAppStore()
	})

	it("setPathname with a plain string replaces pathname directly", () => {
		useAppStore.getState().setPathname("/foo")

		expect(useAppStore.getState().pathname).toBe("/foo")
	})

	it("setPathname with a functional updater receives the current pathname and applies the result", () => {
		useAppStore.getState().setPathname("/base")
		useAppStore.getState().setPathname(prev => prev + "/bar")

		expect(useAppStore.getState().pathname).toBe("/base/bar")
	})

	it("functional updater identity function is a no-op", () => {
		useAppStore.getState().setPathname("/existing")
		useAppStore.getState().setPathname(prev => prev)

		expect(useAppStore.getState().pathname).toBe("/existing")
	})

	it("plain string overwrite after functional update works correctly", () => {
		useAppStore.getState().setPathname(prev => prev + "/child")
		useAppStore.getState().setPathname("/reset")

		expect(useAppStore.getState().pathname).toBe("/reset")
	})
})

// ---------------------------------------------------------------------------
// useAppStore — biometricUnlocked tristate
// ---------------------------------------------------------------------------

describe("useAppStore.biometricUnlocked", () => {
	beforeEach(() => {
		resetAppStore()
	})

	it("initial biometricUnlocked is null — not false, not true", () => {
		expect(useAppStore.getState().biometricUnlocked).toBeNull()
	})

	it("setBiometricUnlocked(true) sets it to true", () => {
		useAppStore.getState().setBiometricUnlocked(true)

		expect(useAppStore.getState().biometricUnlocked).toBe(true)
	})

	it("setBiometricUnlocked(false) sets it to false", () => {
		useAppStore.getState().setBiometricUnlocked(false)

		expect(useAppStore.getState().biometricUnlocked).toBe(false)
	})

	it("setBiometricUnlocked(null) resets it back to null", () => {
		useAppStore.getState().setBiometricUnlocked(true)
		useAppStore.getState().setBiometricUnlocked(null)

		expect(useAppStore.getState().biometricUnlocked).toBeNull()
	})
})
