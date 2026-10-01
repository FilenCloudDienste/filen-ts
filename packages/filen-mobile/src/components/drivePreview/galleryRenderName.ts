import type { GalleryItemTagged } from "@/components/drivePreview/gallery"
import type { DriveItemFileExtracted } from "@/types"
import type { FileSource } from "@/queries/fileSource"
import { getPreviewType, fileTypeExtension, type PreviewType } from "@/lib/previewType"

// The name a page picks its renderer and editor mode by: the one it opened with, for as long as it shows that
// file. A rename elsewhere must never swap an open editor, and its unsaved edits, for another renderer; saves
// still write under the file's current name.
export function galleryItemRenderName(item: GalleryItemTagged): string {
	return item.type === "drive" ? (item.openedName ?? item.data.data.decryptedMeta?.name ?? "") : item.data.name
}

function galleryItemMime(item: GalleryItemTagged): string | undefined {
	return item.type === "drive" ? item.data.data.decryptedMeta?.mime : undefined
}

// The renderer a page uses: by its render name and the file's stored mime, or the text viewer for a file opened
// as text.
export function galleryItemPreviewType(item: GalleryItemTagged): PreviewType {
	if (item.type === "drive" && item.asText) {
		return "text"
	}

	return getPreviewType(galleryItemRenderName(item), galleryItemMime(item))
}

// The extension the text viewer picks its editor mode and highlighting by; "" for a file opened as text, which
// shows as plain text.
export function galleryItemTypeExtension(item: GalleryItemTagged): string {
	if (item.type === "drive" && item.asText) {
		return ""
	}

	return fileTypeExtension(galleryItemRenderName(item), galleryItemMime(item))
}

// `next` shown in place of `existing`: a rename, move, newer version or save of the same file. A file opened as
// text stays in the text viewer.
export function galleryItemFollowing(existing: GalleryItemTagged, next: DriveItemFileExtracted): GalleryItemTagged {
	return {
		type: "drive",
		data: next,
		openedName: galleryItemRenderName(existing),
		...(existing.type === "drive" && existing.asText ? { asText: true } : {})
	}
}

export function galleryItemFileSource(item: GalleryItemTagged): FileSource {
	// The held item goes by value so a cross-directory search hit (not in the global uuid cache) still resolves.
	return item.type === "drive"
		? { type: "drive", data: { uuid: item.data.data.uuid, item: item.data } }
		: { type: "external", data: item.data }
}
