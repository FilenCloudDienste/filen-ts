import { defaultThumbnailDeps } from "@/features/drive/lib/thumbnails"
import { thumbGeneratorsWith, type ThumbByteReaders } from "@/features/drive/lib/thumbGenerators"
import type { ThumbnailSource } from "@/features/drive/lib/thumbnailSource"
import { linkFrameHints, linkProbeRecords } from "@/features/videos/lib/records"
import { sdkApi } from "@/lib/sdk/client"
import { deleteLinkThumbnail, readLinkThumbnail, storeLinkThumbnail } from "@/features/publicLinks/lib/thumbCache"

// A public directory link's files, read through the public-link client: the same generators as the drive's, over the
// anonymous worker calls. Held preview bytes are not reused (the link's cache scope is the page's, not this module's),
// and its keyframe reads keep what they learn for the tab only.
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

const generators = thumbGeneratorsWith(LINK_THUMB_READERS)

// Every category the drive makes, under the drive's own size and kind gates (thumbnailCategory). What is generated
// goes to this tab's sealed store (thumbCache.ts), never the drive's plaintext one. Nothing on a link page copies a
// file, so there are no copies to carry thumbnails over.
export const LINK_THUMBNAIL_SOURCE: ThumbnailSource = {
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
