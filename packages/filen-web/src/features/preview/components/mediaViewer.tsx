import { useEffect, useRef } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import { mediaControlsList, usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { StreamablePreview } from "@/features/preview/components/streamablePreview"
import { getVideoPosition, setVideoPosition } from "@/features/preview/lib/videoContinuity"

export interface MediaViewerProps {
	item: DriveItem
	category: "video" | "audio"
	alt: string
}

// Video-only: loops, autoplays on mount (the overlay's own open is itself a user gesture, so audible
// autoplay is generally permitted — a rejected play() promise is swallowed, leaving the element in its
// normal paused state with no error UI, never an unhandled rejection), and restores/persists playback
// position across a pager remount via videoContinuity.ts, keyed by `positionKey` (the drive item's own
// uuid). The raw, un-chromed <video> the chat thread's own inline mini-player renders directly
// (filenLinkCard.tsx, bypassing this component entirely) is deliberately left without loop/autoplay,
// per the mobile-parity decision that they belong to the full preview experience, not a glanceable
// inline embed.
function VideoElement({
	url,
	alt,
	controlsList,
	onError,
	positionKey
}: {
	url: string
	alt: string
	controlsList: "nodownload" | undefined
	onError?: () => void
	positionKey: string
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null)

	useEffect(() => {
		const video = videoRef.current

		if (!video) {
			return
		}

		function restoreAndPlay(): void {
			if (!video) {
				return
			}

			const saved = getVideoPosition(positionKey)

			if (saved !== undefined) {
				video.currentTime = saved
			}

			// A rejected promise here means the browser blocked autoplay (e.g. no prior user gesture on
			// this exact document, or a restrictive autoplay policy) — the element is already left in its
			// default paused state by the browser itself, so there is nothing further to do: no error UI,
			// no toast, just a swallowed rejection.
			void video.play().catch(() => {
				// Autoplay blocked — see the comment above.
			})
		}

		// readyState >= 1 (HAVE_METADATA) means metadata already loaded before this effect ran (e.g. a
		// cached response) — waiting for a "loadedmetadata" event that already fired would hang forever.
		if (video.readyState >= 1) {
			restoreAndPlay()
		} else {
			video.addEventListener("loadedmetadata", restoreAndPlay, { once: true })
		}

		function handlePause(): void {
			if (video) {
				setVideoPosition(positionKey, video.currentTime)
			}
		}

		video.addEventListener("pause", handlePause)

		return () => {
			video.removeEventListener("loadedmetadata", restoreAndPlay)
			video.removeEventListener("pause", handlePause)

			// Covers stepping away WHILE still playing — the "pause" listener above only fires for an
			// explicit pause, never for an unmount, so this is the only place that captures a mid-playback
			// step-away's own position.
			setVideoPosition(positionKey, video.currentTime)
		}
	}, [positionKey])

	return (
		<video
			ref={videoRef}
			controls
			controlsList={controlsList}
			loop
			preload="metadata"
			src={url}
			aria-label={alt}
			onError={onError}
			className="max-h-full max-w-full"
		/>
	)
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
	// Video-only continuity key (the drive item's own uuid) — see VideoElement's own doc comment.
	// Ignored for category "audio" (mobile's own "3 warm players" precedent is video-specific — audio
	// continuity belongs to the persistent player, not the preview).
	positionKey: string
}) {
	const controlsList = mediaControlsList(usePreviewDownloadable())

	if (category === "video") {
		return (
			<div className="flex size-full items-center justify-center overflow-hidden p-4">
				<VideoElement
					url={url}
					alt={alt}
					controlsList={controlsList}
					{...(onError !== undefined ? { onError } : {})}
					positionKey={positionKey}
				/>
			</div>
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
