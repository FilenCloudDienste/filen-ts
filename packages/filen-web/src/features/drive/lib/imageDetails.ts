import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import { previewCacheScope } from "@/features/preview/lib/accessMode"
import { IMAGE_DETAILS_HEAD_BYTES, imageDetailsFromHead, type ImageDetails } from "@/features/drive/lib/imageDetails.logic"

// The bytes a preview already holds when it has them, else one ranged read of the head, stopped when `signal`
// aborts (the details moved on to another item).
export async function readImageDetails(item: DriveItem, signal: AbortSignal): Promise<ImageDetails | null> {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const size = Number(base.data.size)
	const end = Math.min(size, IMAGE_DETAILS_HEAD_BYTES)
	const held = getPreviewBytes(previewCacheScope("authed", undefined), item.data.uuid)

	if (held !== undefined) {
		return imageDetailsFromHead(held.subarray(0, end), size)
	}

	signal.throwIfAborted()

	const token = crypto.randomUUID()
	const stop = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal.addEventListener("abort", stop, { once: true })

	try {
		return imageDetailsFromHead(await runOp(sdkApi.readFileBytesRange(narrowToAnyFile(item), 0, end, token)), size)
	} finally {
		signal.removeEventListener("abort", stop)
	}
}
