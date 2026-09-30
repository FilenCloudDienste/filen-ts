import type { GalleryItemTagged } from "@/components/drivePreview/gallery"
import type { DriveItemFileExtracted } from "@/types"
import type { FileSource } from "@/queries/fileSource"

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

export function galleryItemFileSource(item: GalleryItemTagged): FileSource {
	// The held item goes by value so a cross-directory search hit (not in the global uuid cache) still resolves.
	return item.type === "drive"
		? { type: "drive", data: { uuid: item.data.data.uuid, item: item.data } }
		: { type: "external", data: item.data }
}
