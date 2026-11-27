import { defaultThumbnailDeps } from "@/features/drive/lib/thumbnails"
import { thumbGeneratorsWith, type ThumbByteReaders } from "@/features/drive/lib/thumbGenerators"
import type { ThumbnailSource } from "@/features/drive/lib/thumbnailSource"
import { linkFrameHints, linkProbeRecords } from "@/features/videos/lib/records"
import { sdkApi } from "@/lib/sdk/client"
import { previewCacheScope } from "@/features/preview/lib/accessMode"
import { deleteLinkThumbnail, readLinkThumbnail, storeLinkThumbnail } from "@/features/publicLinks/lib/thumbCache"

// A public directory link's files, read through the public-link client: the same generators as the drive's, over the
// anonymous worker calls; its keyframe reads keep what they learn for the tab only. Held preview bytes are reused per
// link (linkThumbnailSource sets the scope).
export const LINK_THUMB_READERS: ThumbByteReaders = {
	access: "anon",
	heldScope: null,
	downloadFileBytes: (file, token) => sdkApi.downloadLinkedFileBytesAnon(file, token),
	readFileBytesRange: (file, start, end, token) => sdkApi.readLinkedFileBytesRangeAnon(file, start, end, token),
	readVideoProbe: (file, _uuid, tier, token) => sdkApi.readLinkedVideoProbeAnon(file, tier, token),
	openRangePort: (port, file, token) => sdkApi.openLinkedRangePortAnon(port, file, token),
	makeSdkThumbnail: (file, maxWidth, maxHeight, lossyQuality) =>
		sdkApi.makeLinkedSdkThumbnailAnon(file, maxWidth, maxHeight, lossyQuality),
	makeSdkThumbnailFromFile: (file, maxWidth, maxHeight, lossyQuality) =>
		sdkApi.makeLinkedSdkThumbnailFromFileAnon(file, maxWidth, maxHeight, lossyQuality),
	keyframeRecords: () => ({ probes: linkProbeRecords, hints: linkFrameHints })
}

// The link page's one source, for the link it shows: a new link (or password) makes a new one, and the last is kept.
let current: { linkScope: string; source: ThumbnailSource } | null = null

// Every category the drive makes, under the drive's own size and kind gates (thumbnailCategory), reusing the bytes a
// preview of this link already holds (its cache scope, previewCacheScope) instead of reading them again. What is
// generated goes to this tab's sealed store (thumbCache.ts), never the drive's plaintext one. Nothing on a link page
// copies a file, so there are no copies to carry thumbnails over. The keyframe services stay one per client
// (thumbGenerators.ts), shared by every link's source.
export function linkThumbnailSource(linkScope: string): ThumbnailSource {
	if (current?.linkScope === linkScope) {
		return current.source
	}

	const generators = thumbGeneratorsWith({ ...LINK_THUMB_READERS, heldScope: previewCacheScope("anon", linkScope) })
	const source: ThumbnailSource = {
		deps: {
			...defaultThumbnailDeps,
			readThumbnailBlob: readLinkThumbnail,
			deleteThumbnail: deleteLinkThumbnail,
			storeThumbnail: storeLinkThumbnail,
			copyThumbnails: () => Promise.resolve(),
			getGenerator: category => generators.get(category),
			readBackStored: false
		},
		produces: () => true
	}

	current = { linkScope, source }

	return source
}
