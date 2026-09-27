import type { GalleryItemTagged } from "@/components/drivePreview/gallery"
import type { DriveItemFileExtracted } from "@/types"

// The name a page picks its renderer and editor mode by: the one it opened with, for as long as it shows that
// file. A rename elsewhere must never swap an open editor, and its unsaved edits, for another renderer; saves
// still write under the file's current name.
export function galleryItemRenderName(item: GalleryItemTagged): string {
	return item.type === "drive" ? (item.openedName ?? item.data.data.decryptedMeta?.name ?? "") : item.data.name
}

// `next` shown in place of `existing`: a rename, move, newer version or save of the same file.
export function galleryItemFollowing(existing: GalleryItemTagged, next: DriveItemFileExtracted): GalleryItemTagged {
	return {
		type: "drive",
		data: next,
		openedName: galleryItemRenderName(existing)
	}
}
