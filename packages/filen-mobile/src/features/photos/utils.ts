import { type DriveItem, type DriveItemFileExtracted } from "@/types"
import { getDriveItemPreviewType, isImagePreviewType } from "@/lib/previewType"
import { isFileItem } from "@/features/drive/driveSelectors"

/**
 * Whether a drive item belongs in the photos grid: a decrypted image (incl. svg / RAW) or video file.
 * The photos gallery is handed the grid list as-is, so this is the only filter either applies.
 */
export function isPhotoGridItem(item: DriveItem): item is DriveItemFileExtracted {
	if (!isFileItem(item) || !item.data.decryptedMeta) {
		return false
	}

	const previewType = getDriveItemPreviewType(item)

	return isImagePreviewType(previewType) || previewType === "video"
}
