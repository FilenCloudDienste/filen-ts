import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { imageDecodeFor, pendingImageProbe, previewType } from "@/features/drive/lib/preview.logic"
import { routeFor } from "@/features/preview/lib/imageRoute"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { holdPreviewStream, isMediaStreamAvailable, previewStreamUrl, releasePreviewStreamSoon } from "@/features/preview/lib/previewStream"
import { getPreviewBytes, getPreviewStreamId, previewCacheEpoch, setPreviewStreamId } from "@/features/preview/lib/previewCache"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { NATIVE_VIEW_SNIFF_FROM_BYTES, nativeViewCrash } from "@/lib/pixelBudget"

// Loads an image ahead under the stream id its viewer will reuse (previewCache.ts), so the browser answers the
// viewer's <img> from what it already holds. Only where that viewer would stream the same URL: a drive or link
// file on the native route, with no probe pending, no decoder of our own behind it (that registers a fresh id
// each time), no bytes held (that shows from memory) and no size gate before it. Null where nothing is loaded.
// The returned dispose drops the image and lets go of the stream; a viewer holding it keeps it.
export function prefetchPreviewImage(
	item: DriveItem,
	scope: string | null,
	access: PreviewAccessMode,
	profile: DeviceProfile
): (() => void) | null {
	if (
		scope === null ||
		previewType(item) !== "image" ||
		routeFor(item, profile) !== "native" ||
		pendingImageProbe(item, profile) !== null
	) {
		return null
	}

	const decode = imageDecodeFor(item)
	const contentType = allowedMediaContentType(item, profile)
	const uuid = item.data.uuid

	if (
		(decode !== null && decode !== "native") ||
		contentType === null ||
		!isMediaStreamAvailable() ||
		getPreviewBytes(scope, uuid) !== undefined ||
		(nativeViewCrash(profile) !== null && Number(item.data.size) >= NATIVE_VIEW_SNIFF_FROM_BYTES)
	) {
		return null
	}

	const epoch = previewCacheEpoch()
	const id = getPreviewStreamId(scope, uuid, contentType) ?? crypto.randomUUID()
	let image: HTMLImageElement | null = null
	let disposed = false

	holdPreviewStream(id)

	previewStreamUrl(narrowToAnyFile(item), driveItemName(item), contentType, id, { access }).then(
		url => {
			// Kept as a viewer's registration is: the viewer registers this id again whatever came of the load.
			setPreviewStreamId(scope, uuid, contentType, id, epoch)

			if (disposed) {
				return
			}

			// No crossOrigin, as the viewer's <img>: the same request, so the same cache entry.
			image = new Image()
			image.src = url
			image.decode().then(
				() => undefined,
				() => {
					// The viewer shows whatever this failed on.
				}
			)
		},
		() => {
			// The viewer registers again and shows the failure.
		}
	)

	return () => {
		disposed = true
		image?.removeAttribute("src")
		image = null
		releasePreviewStreamSoon(id)
	}
}
