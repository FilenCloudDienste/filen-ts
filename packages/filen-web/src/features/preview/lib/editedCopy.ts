import { driveItemName } from "@filen/shared"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { editedCopyName } from "@/features/drive/lib/copyName"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { editedSaveTimes, runPreviewSave, type PreviewSaveDeps } from "@/features/drive/lib/previewSave.logic"
import { warmUploadThumbnail } from "@/features/drive/lib/thumbGenerators"
import { driveListingQueryUpdate, normalizeParentUuid } from "@/features/drive/queries/drive"
import { takenNames } from "@/features/preview/imageEdit/editSession"
import type { ActionOutcome } from "@/lib/actions/outcome"
import { sdkApi } from "@/lib/sdk/client"

// An edited image's upload: its Blob streamed by the SDK worker (the drive's thumbnail then made from that Blob, no
// download), or the original streamed back with a new Exif Orientation.
export function imageSaveDeps(): PreviewSaveDeps {
	return {
		uploadFileBytes: (parentUuid, data, name, mime, options) => sdkApi.uploadFileBytes(parentUuid, data, name, mime, options),
		uploadFileBlob: (parentUuid, blob, name, mime, options) =>
			sdkApi.uploadFileFromBlob(parentUuid, blob, name, mime, options).then(file => {
				warmUploadThumbnail(file, new File([blob], name, { type: blob.type }))

				return file
			}),
		rewriteOrientation: (file, orientation, parentUuid, name, mime, options) =>
			sdkApi.rewriteJpegOrientation(file, orientation, parentUuid, name, mime, options),
		patchListing: driveListingQueryUpdate,
		rootUuid: currentRootUuid()
	}
}

// A picture made from `item` (an edited image, a video's frame) as a new file beside it, named "photo (edited).jpg" (or
// the first such name free) from one read of the directory's names, typed by the SDK from that name, with the
// original's dates. Null when `item` is not a file.
export async function writeEditedCopy(
	item: DriveItem,
	blob: Blob,
	extension: string,
	suffix: (number: number) => string
): Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null> {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const taken = await takenNames(normalizeParentUuid(base.data.parent, currentRootUuid()))
	const name = editedCopyName(driveItemName(base), extension, suffix, taken)
	const outcome = await runPreviewSave(imageSaveDeps(), {
		item,
		content: { blob },
		asNewFile: name,
		mime: "",
		times: editedSaveTimes(item, Date.now())
	})

	return { outcome, name }
}
