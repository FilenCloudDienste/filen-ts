import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import type { FileVerdict } from "@filen/shared"
import { CATEGORY_POLICY, needsContentSniff, previewType, type PreviewCategory } from "@/features/drive/lib/preview.logic"

// Mobile parity (features/photos/utils.ts's own isPhotoGridItem): keep only file-kind items with
// decrypted metadata whose preview category is image, rawImage or video — directories and
// undecryptable items are dropped. Deliberately reuses WEB's own preview-type classifier (previewType, the SAME category
// resolution the drive grid's video badge and the preview overlay itself use) rather than porting
// mobile's EXPO_IMAGE_SUPPORTED_EXTENSIONS allowlist, which is an expo-image capability set with no
// meaning on the web platform — previewType's own image tier (IMAGE_FORMATS) is already
// web's equivalent gate for what counts as a displayable image here. Videos pass unconditionally,
// exactly like mobile's own predicate.
//
// The decrypted-meta check is technically redundant with previewType's own behavior (an undecryptable
// file has no name/mime to categorize, so it already resolves "other" and fails the category check
// below) — kept explicit anyway so the invariant this predicate promises (a photos listing can never
// contain an undecryptable row) reads directly off this function's body, not as a side effect of
// previewType's fallback.
//
// `verdict` as previewType takes it: the store's when absent, none when null.
export function isPhotoItem(item: DriveItem, verdict?: FileVerdict | null): boolean {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.decryptedMeta === null) {
		return false
	}

	return isPhotoCategory(previewType(item, verdict))
}

// rawImage joins image/video: a camera RAW is a photo by any user's reckoning, and the grid's tile is
// thumbnail-driven — the SDK produces those for RAW (usually straight off the embedded preview), so a RAW row
// renders exactly like every other photo, and the viewer shows its embedded preview.
export function isPhotoCategory(category: PreviewCategory | null): boolean {
	return category !== null && CATEGORY_POLICY[category].photo
}

// Whether the item is a photo by its name and MIME type alone, or a `.ts`/`.mts` a probe could still find to be
// a transport stream: what a photos listing keeps, without verdicts, so it reads the same in the SDK worker,
// a socket event about any other file never walks the listing again, and a verdict that lands needs no walk.
// What it shows is decided as it is read (isPhotoItem): an "audio" verdict hides a video that holds no
// picture. An audio-signalled `.mp4`/`.webm`/`.mkv` and the audio extensions are no candidates.
export function isPhotoCandidate(item: DriveItem): boolean {
	if (isPhotoItem(item, null)) {
		return true
	}

	return needsContentSniff(item, null) === "transportStream" && isPhotoItem(item, "transportStream")
}
