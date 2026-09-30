import type { DriveItem } from "@/features/drive/lib/item"
import { mediaControlsList, usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { StreamablePreview } from "@/features/preview/components/streamablePreview"
import { VideoPlayer } from "@/features/preview/components/videoPlayer"

export interface MediaViewerProps {
	item: DriveItem
	category: "video" | "audio"
	alt: string
}

// The actual <video>/<audio> element, rendered once a src URL is known (either StreamablePreview mode) — Media
// Session metadata is deliberately out of scope here (a later, separate concern). `preload="metadata"`
// avoids eagerly streaming the whole file just to show a scrubber; the SW route/blob URL both support
// seeking past that point either way (the SW via Range/206, a blob URL via the browser's own in-memory
// random access).
export function MediaElement({
	category,
	url,
	alt,
	onError,
	positionKey
}: {
	category: "video" | "audio"
	url: string
	alt: string
	// Streamed path only (see RenderPreviewUrl).
	onError?: (() => void) | undefined
	// Video-only continuity key (the drive item's own uuid) — see videoPlayer.tsx's useVideoContinuity.
	// Ignored for category "audio" (mobile's own "3 warm players" precedent is video-specific — audio
	// continuity belongs to the persistent player, not the preview).
	positionKey: string
}) {
	const downloadable = usePreviewDownloadable()
	const controlsList = mediaControlsList(downloadable)

	if (category === "video") {
		return (
			<VideoPlayer
				url={url}
				alt={alt}
				downloadable={downloadable}
				onError={onError}
				positionKey={positionKey}
			/>
		)
	}

	return (
		<div className="flex size-full items-center justify-center px-6">
			<audio
				controls
				controlsList={controlsList}
				preload="metadata"
				src={url}
				aria-label={alt}
				onError={onError}
				className="w-full max-w-md"
			/>
		</div>
	)
}

// Streamed through the SW's inline route when available, else buffered — see StreamablePreview.
export function MediaViewer({ item, category, alt }: MediaViewerProps) {
	return (
		<StreamablePreview
			item={item}
			render={(url, onError) => (
				<MediaElement
					category={category}
					url={url}
					alt={alt}
					positionKey={item.data.uuid}
					onError={onError}
				/>
			)}
		/>
	)
}
