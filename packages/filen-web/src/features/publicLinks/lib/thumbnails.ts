import { defaultThumbnailDeps, type ThumbGeneratorCategory } from "@/features/drive/lib/thumbnails"
import { generateLinkedSdkThumb } from "@/features/drive/lib/thumbGenerators"
import type { ThumbnailSource } from "@/features/drive/lib/thumbnailSource"

// A public directory's grid thumbnails: images the SDK decodes, read through the public-link client. Never written to
// or read from the drive's OPFS thumbnail store (decrypted derivatives of someone else's files stay out of this
// browser's disk), so a tile's thumbnail lives only in the service's bounded objectURL cache. Video, PDF and the other
// browser-decoded kinds stay icons: their generators read through the session client.
export function linkThumbnailProduces(category: ThumbGeneratorCategory): boolean {
	return category === "sdk"
}

export const LINK_THUMBNAIL_SOURCE: ThumbnailSource = {
	deps: {
		...defaultThumbnailDeps,
		readThumbnailBlob: () => Promise.resolve(null),
		deleteThumbnail: () => Promise.resolve(),
		storeThumbnail: () => Promise.resolve(),
		copyThumbnails: () => Promise.resolve(),
		getGenerator: category => (linkThumbnailProduces(category) ? generateLinkedSdkThumb : undefined)
	},
	produces: linkThumbnailProduces
}
