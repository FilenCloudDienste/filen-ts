import { type DriveItem, type DriveItemFileExtracted } from "@/types"
import { type PreviewType } from "@/lib/previewType"

/**
 * Pure predicate deciding whether a drive item should appear in the photos grid.
 *
 * Keeps only image / video files whose extension is renderable. Directories,
 * items without decrypted metadata and non-(shared-)file types are dropped.
 * Images additionally require their extension to be in the supported-image set
 * (videos are accepted unconditionally). All heavy/native dependencies
 * (`getPreviewType`, the supported-extension set and `extname`) are injected so
 * the predicate stays side-effect-free and trivially testable.
 */
export function isPhotoGridItem({
	item,
	getPreviewType,
	supportedImageExtensions,
	extname
}: {
	item: DriveItem
	getPreviewType: (name: string) => PreviewType
	supportedImageExtensions: Set<string>
	extname: (path: string) => string
}): boolean {
	if (!item.data.decryptedMeta || (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile")) {
		return false
	}

	const previewType = getPreviewType(item.data.decryptedMeta.name)
	// `svg` is image-equivalent for grid eligibility (it renders via react-native-svg, not
	// expo-image — see PreviewSvg). Inlined rather than importing isImagePreviewType to keep this
	// predicate free of runtime @/lib deps (getPreviewType is injected for the same reason).
	const isImage = previewType === "image" || previewType === "svg"

	return (
		(isImage || previewType === "video") &&
		(isImage ? supportedImageExtensions.has(extname(item.data.decryptedMeta.name).toLowerCase()) : true)
	)
}

/**
 * Filters a list of drive items down to the supported photo-grid items. The
 * result is widened to `DriveItemFileExtracted[]` since `isPhotoGridItem` only
 * ever returns true for file / shared-file types.
 */
export function filterPhotoGridItems({
	items,
	getPreviewType,
	supportedImageExtensions,
	extname
}: {
	items: DriveItem[]
	getPreviewType: (name: string) => PreviewType
	supportedImageExtensions: Set<string>
	extname: (path: string) => string
}): DriveItemFileExtracted[] {
	return items.filter(item =>
		isPhotoGridItem({
			item,
			getPreviewType,
			supportedImageExtensions,
			extname
		})
	) as DriveItemFileExtracted[]
}
