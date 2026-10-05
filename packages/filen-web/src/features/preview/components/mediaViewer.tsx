import { useState } from "react"
import { cn } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { BlockSource, bytesReadRange, urlReadRange } from "@/lib/media/blockSource"
import { reportMediaFailure, type MediaFailureKind } from "@/lib/media/mediaFailure"
import { mediaControlsList, usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { StreamablePreview } from "@/features/preview/components/streamablePreview"
import { VideoPlayer } from "@/features/preview/components/videoPlayer"
import { MediaFailureState } from "@/features/preview/components/mediaFailureState"
import { useReleaseOnUnmount } from "@/lib/media/useReleaseOnUnmount"

export interface MediaViewerProps {
	item: DriveItem
	category: "video" | "audio"
	alt: string
}

// The actual <video>/<audio> element, rendered once a src URL is known (either StreamablePreview mode) — Media
// Session metadata is deliberately out of scope here (a later, separate concern). `preload="metadata"`
// avoids eagerly streaming the whole file just to show a scrubber; the SW route/blob URL both support
// seeking past that point either way (the SW via Range/206, a blob URL via the browser's own in-memory
// random access). Keyed by `url` at its call site: the byte source below belongs to one URL.
export function MediaElement({
	category,
	url,
	alt,
	onError,
	positionKey,
	size,
	bytes
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
	size: number
	// Buffered path only: the file the blob URL holds.
	bytes?: Uint8Array | undefined
}) {
	const downloadable = usePreviewDownloadable()
	// Reads the bytes in memory when there are some, else ranges of the URL the element itself streams.
	const [source] = useState(() =>
		bytes !== undefined ? new BlockSource(bytes.length, bytesReadRange(bytes)) : new BlockSource(size, urlReadRange(url))
	)

	if (category === "video") {
		return (
			<VideoPlayer
				url={url}
				alt={alt}
				downloadable={downloadable}
				onError={onError}
				positionKey={positionKey}
				source={source}
			/>
		)
	}

	return (
		<PreviewAudio
			url={url}
			alt={alt}
			downloadable={downloadable}
			onError={onError}
			source={source}
		/>
	)
}

function PreviewAudio({
	url,
	alt,
	downloadable,
	onError,
	source
}: {
	url: string
	alt: string
	downloadable: boolean
	onError: (() => void) | undefined
	source: BlockSource
}) {
	const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
	const [failure, setFailure] = useState<MediaFailureKind | null>(null)

	useReleaseOnUnmount(audio)

	return (
		<div className="relative flex size-full items-center justify-center px-6">
			{/* Hidden, not unmounted, once playback failed: a fresh element would only load and fail again. */}
			<audio
				ref={setAudio}
				controls
				controlsList={mediaControlsList(downloadable)}
				preload="metadata"
				src={url}
				aria-label={alt}
				className={cn("w-full max-w-md", failure !== null && "hidden")}
				onError={event => {
					reportMediaFailure(event.currentTarget, source, kind => {
						if (kind === "other" && onError !== undefined) {
							onError()
						} else {
							setFailure(kind)
						}
					})
				}}
			/>
			{failure !== null && audio !== null ? (
				<div className="absolute inset-0">
					<MediaFailureState
						kind={failure}
						media={audio}
						source={source}
					/>
				</div>
			) : null}
		</div>
	)
}

// Streamed through the SW's inline route when available, else buffered — see StreamablePreview.
export function MediaViewer({ item, category, alt }: MediaViewerProps) {
	const size = Number(asDirectoryOrFile(item).data.size)

	return (
		<StreamablePreview
			item={item}
			render={(url, onError, bytes) => (
				<MediaElement
					key={url}
					category={category}
					url={url}
					alt={alt}
					positionKey={item.data.uuid}
					onError={onError}
					size={size}
					bytes={bytes}
				/>
			)}
		/>
	)
}
