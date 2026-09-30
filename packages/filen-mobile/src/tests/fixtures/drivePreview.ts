import { useDrivePreviewStore } from "@/stores/useDrivePreview.store"
import type { GalleryItemTagged, InitialItem } from "@/components/drivePreview/gallery"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"

export function makeDrivePath(type: DrivePathType = "drive"): DrivePath {
	return { type, uuid: "root-uuid" }
}

// The name decides which previewType the gallery filter assigns.
export function makeDriveGalleryItem(
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

export function makeInitialDriveItem(uuid: string, name: string, drivePath: DrivePath = makeDrivePath()): InitialItem {
	return {
		type: "drive",
		data: {
			item: makeDriveGalleryItem(uuid, name).data as never,
			drivePath
		}
	}
}

export function makeInitialExternalItem(): InitialItem {
	return {
		type: "external",
		data: { uri: "file:///tmp/ext.jpg", name: "ext.jpg", mimeType: "image/jpeg" } as never
	}
}

export function resetDrivePreviewStore(): void {
	useDrivePreviewStore.setState({
		headerHeight: null,
		currentItem: null,
		currentIndex: null,
		items: [],
		initialScrollIndex: 0,
		drivePath: null,
		isLeaving: false,
		pendingOpen: null
	})
}
