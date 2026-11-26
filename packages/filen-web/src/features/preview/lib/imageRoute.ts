import type { DriveItem } from "@/features/drive/lib/item"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { needsImageTransform } from "@/features/drive/lib/preview.logic"

// How an image is shown: as the browser decodes it (streamed, or from its buffered fallback), decoded by our own code
// first, or decoded by our own code after the browser failed to decode the whole file.
export type ImageRoute = "native" | "decoded" | "undecodable"

// The route an image opens on (the image viewer's, and the slideshow's when it loads one ahead).
export function routeFor(item: DriveItem, profile: DeviceProfile): ImageRoute {
	return needsImageTransform(item, profile) ? "decoded" : "native"
}
