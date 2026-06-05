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

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/previewType", async () => {
    const actual = await import("@/tests/mocks/expoFileSystem")

    return {
        getPreviewType(name: string): string {
            const ext = actual.Paths.extname(name.trim().toLowerCase())

            if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".heic", ".heif", ".webp", ".avif"].includes(ext)) {
                return "image"
            }

            if ([".mp4", ".mov", ".m4v", ".3gp", ".webm", ".mkv"].includes(ext)) {
                return "video"
            }

            if ([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"].includes(ext)) {
                return "audio"
            }

            switch (ext) {
                case ".pdf":
                    return "pdf"
                case ".txt":
                    return "text"
                case ".docx":
                    return "docx"
                case ".js":
                case ".ts":
                case ".tsx":
                case ".py":
                case ".rs":
                case ".json":
                    return "code"
                default:
                    return "unknown"
            }
        }
    }
})

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))
vi.mock("@filen/sdk-rs", () => ({}))

import { useDrivePreviewStore } from "@/stores/useDrivePreview.store"
import type { GalleryItemTagged, InitialItem } from "@/components/drivePreview/gallery"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDrivePath(type: DrivePathType = "drive"): DrivePath {
    return { type, uuid: "root-uuid" }
}

function makeDriveGalleryItem(
    uuid: string,
    name: string,
    itemType: string = "file",
    decryptedMeta: { name: string; size: bigint } | null = { name, size: 0n }
): GalleryItemTagged {
    return {
        type: "drive",
        data: {
            type: itemType,
            data: {
                uuid,
                decryptedMeta,
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

function resetStore(): void {
    useDrivePreviewStore.setState({
        headerHeight: null,
        currentItem: null,
        currentIndex: null,
        items: [],
        initialScrollIndex: 0,
        drivePath: null
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDrivePreviewStore.open — uncovered spec cases", () => {
    beforeEach(() => {
        resetStore()
        mockRouterPush.mockClear()
    })

    describe("null decryptedMeta exclusion", () => {
        it("excludes drive items with null decryptedMeta from the gallery filter (regular drive path)", () => {
            const nullMetaItem = makeDriveGalleryItem("null-meta", "photo.jpg", "file", null)
            const validItem = makeDriveGalleryItem("valid", "valid.jpg")
            const items: GalleryItemTagged[] = [nullMetaItem, validItem]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("valid", "valid.jpg")
            })

            const state = useDrivePreviewStore.getState()
            const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

            expect(uuids).not.toContain("null-meta")
            expect(uuids).toContain("valid")
        })

        it("excludes drive items with null decryptedMeta from the photos path filter", () => {
            const photosDrivePath = makeDrivePath("photos")
            const nullMetaItem = makeDriveGalleryItem("null-meta", "photo.jpg", "file", null)
            const validItem = makeDriveGalleryItem("valid", "valid.jpg")
            const items: GalleryItemTagged[] = [nullMetaItem, validItem]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("valid", "valid.jpg", photosDrivePath)
            })

            const state = useDrivePreviewStore.getState()
            const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

            expect(uuids).not.toContain("null-meta")
            expect(uuids).toContain("valid")
        })

        it("returns early (no navigation) when the only matching item has null decryptedMeta and initialItem is missing", () => {
            // Only item is a null-meta item; it gets filtered out, so initialScrollIndex will be -1
            const nullMetaItem = makeDriveGalleryItem("null-meta", "photo.jpg", "file", null)
            const items: GalleryItemTagged[] = [nullMetaItem]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("null-meta", "photo.jpg")
            })

            // initItem is undefined (filtered out), so open() returns early
            expect(useDrivePreviewStore.getState().currentItem).toBeNull()
            expect(useDrivePreviewStore.getState().currentIndex).toBeNull()
            expect(mockRouterPush).not.toHaveBeenCalled()
        })
    })

    describe("directory and sharedDirectory exclusion", () => {
        it("excludes items of type 'directory' from the gallery filter even if the filename would match an image extension", () => {
            // A directory named "photo.jpg" would match getPreviewType → "image",
            // but the filter must reject it because item.data.type is "directory"
            const dirItem = makeDriveGalleryItem("dir1", "photo.jpg", "directory")
            const fileItem = makeDriveGalleryItem("file1", "other.jpg")
            const items: GalleryItemTagged[] = [dirItem, fileItem]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("file1", "other.jpg")
            })

            const state = useDrivePreviewStore.getState()
            const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

            expect(uuids).not.toContain("dir1")
            expect(uuids).toContain("file1")
        })

        it("excludes items of type 'sharedDirectory' from the gallery filter", () => {
            const sharedDirItem = makeDriveGalleryItem("sdir1", "photo.jpg", "sharedDirectory")
            const fileItem = makeDriveGalleryItem("file1", "other.jpg")
            const items: GalleryItemTagged[] = [sharedDirItem, fileItem]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("file1", "other.jpg")
            })

            const state = useDrivePreviewStore.getState()
            const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

            expect(uuids).not.toContain("sdir1")
            expect(uuids).toContain("file1")
        })

        it("excludes directory items from the photos path filter as well", () => {
            const photosDrivePath = makeDrivePath("photos")
            const dirItem = makeDriveGalleryItem("dir1", "photo.jpg", "directory")
            const fileItem = makeDriveGalleryItem("file1", "valid.jpg")
            const items: GalleryItemTagged[] = [dirItem, fileItem]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("file1", "valid.jpg", photosDrivePath)
            })

            const state = useDrivePreviewStore.getState()
            const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

            expect(uuids).not.toContain("dir1")
            expect(uuids).toContain("file1")
        })
    })

    describe("drivePath state after open()", () => {
        it("sets drivePath to null when initialItem is of type 'external'", () => {
            const items: GalleryItemTagged[] = [makeDriveGalleryItem("img1", "photo.jpg")]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialExternalItem()
            })

            expect(useDrivePreviewStore.getState().drivePath).toBeNull()
        })

        it("sets drivePath to initialItem.data.drivePath when initialItem is of type 'drive'", () => {
            const drivePath = makeDrivePath("drive")
            const items: GalleryItemTagged[] = [makeDriveGalleryItem("img1", "photo.jpg")]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("img1", "photo.jpg", drivePath)
            })

            expect(useDrivePreviewStore.getState().drivePath).toEqual(drivePath)
        })

        it("sets drivePath to the photos drive path when opening from the photos tab", () => {
            const photosDrivePath = makeDrivePath("photos")
            const items: GalleryItemTagged[] = [makeDriveGalleryItem("img1", "photo.jpg")]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("img1", "photo.jpg", photosDrivePath)
            })

            expect(useDrivePreviewStore.getState().drivePath).toEqual(photosDrivePath)
        })
    })

    describe("unknown preview type exclusion", () => {
        it("excludes items with unknown preview type from the regular drive gallery", () => {
            const unknownItem = makeDriveGalleryItem("unknown1", "archive.zip")
            const imageItem = makeDriveGalleryItem("img1", "photo.jpg")
            const items: GalleryItemTagged[] = [unknownItem, imageItem]

            useDrivePreviewStore.getState().open({
                items,
                initialItem: makeInitialDriveItem("img1", "photo.jpg")
            })

            const state = useDrivePreviewStore.getState()
            const uuids = state.items.map(i => (i as Extract<GalleryItemTagged, { type: "drive" }>).data.data.uuid)

            expect(uuids).not.toContain("unknown1")
            expect(uuids).toContain("img1")
        })
    })
})
