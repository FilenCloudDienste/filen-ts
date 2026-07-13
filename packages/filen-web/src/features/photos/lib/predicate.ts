import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"

// Mobile parity (features/photos/utils.ts's own isPhotoGridItem): keep only file-kind items with
// decrypted metadata whose preview category is image or video — directories and undecryptable items
// are dropped. Deliberately reuses WEB's own preview-type classifier (previewType, the SAME category
// resolution the drive grid's video badge and the preview overlay itself use) rather than porting
// mobile's EXPO_IMAGE_SUPPORTED_EXTENSIONS allowlist, which is an expo-image capability set with no
// meaning on the web platform — previewType's own IMAGE_EXTENSIONS/HEIC_EXTENSIONS sets are already
// web's equivalent gate for what counts as a displayable image here. Videos pass unconditionally,
// exactly like mobile's own predicate.
//
// The decrypted-meta check is technically redundant with previewType's own behavior (an undecryptable
// file has no name/mime to categorize, so it already resolves "other" and fails the category check
// below) — kept explicit anyway so the invariant this predicate promises (a photos listing can never
// contain an undecryptable row) reads directly off this function's body, not as a side effect of
// previewType's fallback.
export function isPhotoItem(item: DriveItem): boolean {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.decryptedMeta === null) {
		return false
	}

	const category = previewType(item)

	return category === "image" || category === "video"
}
