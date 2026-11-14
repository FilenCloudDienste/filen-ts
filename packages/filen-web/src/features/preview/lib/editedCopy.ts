import { driveItemName } from "@filen/shared"
import { savePortReader } from "@filen/shared/savePort"
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

// A port-streamed save's upload: the writer on the port's other end (a worker) streams the file to the SDK worker,
// which uploads as it reads; the page never holds it.
function portSaveDeps(): PreviewSaveDeps {
	return {
		uploadFileBytes: (parentUuid, data, name, mime, options) => sdkApi.uploadFileBytes(parentUuid, data, name, mime, options),
		uploadFileFromPort: (parentUuid, port, name, mime, options) => sdkApi.uploadFileFromPort(parentUuid, name, mime, port, options),
		patchListing: driveListingQueryUpdate,
		rootUuid: currentRootUuid()
	}
}

// What an edited copy is written from: a Blob (an edited image, a video's frame), or a port a worker writes the file
// to, `size` its exact length.
export type EditedCopyContent = { readonly blob: Blob } | { readonly port: MessagePort; readonly size: number }

// A file made from `item` (an edited image, a video's frame, an edited PDF) as a new file beside it, named
// "photo (edited).jpg" (or the first such name free) from one read of the directory's names, typed by the SDK from
// that name, with the original's dates. Null when `item` is not a file (a port is then closed unread).
export async function writeEditedCopy(
	item: DriveItem,
	content: EditedCopyContent,
	extension: string,
	suffix: (number: number) => string
): Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null> {
	// The writer on a port's other end would otherwise block on a reader that never comes: told by the save port's own
	// abort (closing a port tells the other end nothing).
	const closePort = (): void => {
		if ("port" in content) {
			savePortReader(content.port, { inFlight: 1 }).abort("cancelled")
		}
	}
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		closePort()

		return null
	}

	const taken = await takenNames(normalizeParentUuid(base.data.parent, currentRootUuid())).catch((e: unknown) => {
		closePort()

		throw e
	})
	const name = editedCopyName(driveItemName(base), extension, suffix, taken)
	const outcome = await runPreviewSave("blob" in content ? imageSaveDeps() : portSaveDeps(), {
		item,
		content,
		asNewFile: name,
		mime: "",
		times: editedSaveTimes(item, Date.now())
	})

	return { outcome, name }
}
