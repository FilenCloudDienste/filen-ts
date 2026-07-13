import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { streamFailureAction } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"
import { getVideoPlaybackState, setVideoPlaybackState } from "@/features/preview/lib/videoContinuity"

export interface MediaViewerProps {
	item: DriveItem
	category: "video" | "audio"
	alt: string
}

// Video-only: loops, autoplays on mount (the overlay's own open is itself a user gesture, so audible
// autoplay is generally permitted — a rejected play() promise is swallowed, leaving the element in its
// normal paused state with no error UI, never an unhandled rejection), and restores/persists playback
// position across a pager remount via videoContinuity.ts. `positionKey` (the drive item's own uuid) is
// undefined only for the external preview arm (previewOverlay.tsx's ExternalPreviewBody — no drive
// item exists there to key a persisted position against); loop/autoplay still apply either way since
// both arms render inside the SAME full-screen preview surface — only the raw, un-chromed <video> the
// chat thread's own inline mini-player renders directly (filenLinkCard.tsx, bypassing this component
// entirely) is deliberately excluded, per the mobile-parity decision that loop/autoplay belong to the
// full preview experience, not a glanceable inline embed.
function VideoElement({ url, alt, onError, positionKey }: { url: string; alt: string; onError?: () => void; positionKey?: string }) {
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

			const saved = positionKey !== undefined ? getVideoPlaybackState(positionKey) : undefined

			if (saved !== undefined) {
				video.currentTime = saved.currentTime
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
			if (positionKey !== undefined && video) {
				setVideoPlaybackState(positionKey, { currentTime: video.currentTime })
			}
		}

		video.addEventListener("pause", handlePause)

		return () => {
			video.removeEventListener("loadedmetadata", restoreAndPlay)
			video.removeEventListener("pause", handlePause)

			// Covers stepping away WHILE still playing — the "pause" listener above only fires for an
			// explicit pause, never for an unmount, so this is the only place that captures a mid-playback
			// step-away's own position.
			if (positionKey !== undefined) {
				setVideoPlaybackState(positionKey, { currentTime: video.currentTime })
			}
		}
	}, [positionKey])

	return (
		<video
			ref={videoRef}
			controls
			loop
			preload="metadata"
			src={url}
			aria-label={alt}
			onError={onError}
			className="max-h-full max-w-full"
		/>
	)
}

// The actual <video>/<audio> element, rendered once a src URL is known (either mode below) — Media
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
	// Only ever wired by the streamed path (StreamedMedia below) — the buffered blob path has nowhere
	// further to fall back to, so it leaves this unset and keeps the browser's own native error state.
	onError?: () => void
	// Video-only continuity key (the drive item's own uuid) — see VideoElement's own doc comment.
	// Ignored for category "audio" (mobile's own "3 warm players" precedent is video-specific — audio
	// continuity belongs to the persistent player, not the preview).
	positionKey?: string
}) {
	if (category === "video") {
		return (
			<div className="flex size-full items-center justify-center overflow-hidden p-4">
				<VideoElement
					url={url}
					alt={alt}
					{...(onError !== undefined ? { onError } : {})}
					{...(positionKey !== undefined ? { positionKey } : {})}
				/>
			</div>
		)
	}

	return (
		<div className="flex size-full items-center justify-center px-6">
			<audio
				controls
				preload="metadata"
				src={url}
				aria-label={alt}
				onError={onError}
				className="w-full max-w-md"
			/>
		</div>
	)
}

// Streamed mode: registers against the SW's inline route and renders once a URL resolves. A
// registration failure hands control back to the parent (onFallback) for the buffered fallback ONLY
// when the file is under the whole-buffer cap (streamFailureAction, the SAME decision the mid-
// consumption onError handler below applies) — an oversize file gets the labeled error state instead,
// never an unbounded buffered retry (a multi-GB video on a prod SW hiccup would otherwise whole-buffer
// straight into a tab-crashing allocation, since a streamed category is never capped at the open gate,
// preview.logic.ts).
function StreamedMedia({
	item,
	category,
	alt,
	contentType,
	onFallback
}: {
	item: DriveItem
	category: "video" | "audio"
	alt: string
	contentType: string
	onFallback: () => void
}) {
	const { t } = useTranslation("preview")
	const name = item.data.decryptedMeta?.name ?? item.data.uuid
	const result = usePreviewStreamUrl(item, name, contentType)
	// Mid-consumption-only (set from the onError DOM event below, a genuine event handler — never an
	// effect). The registration-failure case is deliberately NOT routed through this: see
	// registrationOverCap just below for why.
	const [capExceeded, setCapExceeded] = useState(false)
	// A pure derivation, not a second setCapExceeded(true) from the effect below: `result.status`/`item`
	// are already reactive inputs, so an over-cap REGISTRATION failure needs no stored state or effect-
	// time setState to recompute this fresh each render (react-hooks/set-state-in-effect flags exactly
	// that — a direct setState call synchronously inside an effect body — which the onError handler below
	// is exempt from only because it's a genuine DOM event callback, not an effect).
	const registrationOverCap = result.status === "error" && streamFailureAction(item) === "error"

	useEffect(() => {
		if (result.status === "error" && streamFailureAction(item) === "buffer") {
			onFallback()
		}
	}, [result.status, onFallback, item])

	// Checked BEFORE the pending/error spinner below: an over-cap REGISTRATION failure leaves
	// `result.status` permanently "error" (never "success"), so this must win regardless of that status,
	// not just after it — unlike the mid-consumption path, where `result.status` is already "success" by
	// the time onError can ever set `capExceeded`, so the ordering is a no-op there.
	if (capExceeded || registrationOverCap) {
		return (
			<PreviewErrorState
				message={t("previewStreamFailed")}
				onRetry={() => {
					setCapExceeded(false)
					result.refetch()
				}}
			/>
		)
	}

	if (result.status !== "success") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	return (
		<MediaElement
			category={category}
			url={result.url}
			alt={alt}
			positionKey={item.data.uuid}
			onError={() => {
				// A mid-consumption failure (network drop mid-seek, an SW-side decrypt abort, a lifecycle
				// hiccup) — unlike the registration-failure effect above, retrying buffered here would
				// re-download the whole file, so an oversize item gets the labeled error instead.
				if (streamFailureAction(item) === "buffer") {
					onFallback()
				} else {
					setCapExceeded(true)
				}
			}}
		/>
	)
}

function BufferedMediaBytes({
	category,
	bytes,
	mime,
	alt,
	positionKey
}: {
	category: "video" | "audio"
	bytes: Uint8Array
	mime: string | undefined
	alt: string
	positionKey: string
}) {
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		// Mirrors imageViewer.tsx's own blob-mint effect — see its comment for the ArrayBuffer-narrowing
		// and double-invoke-safety rationale, identical here.
		const objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime ?? "application/octet-stream" }))

		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate, see imageViewer.tsx's own identical effect
		setUrl(objectUrl)

		return () => {
			URL.revokeObjectURL(objectUrl)
		}
	}, [bytes, mime])

	if (!url) {
		return null
	}

	return (
		<MediaElement
			category={category}
			url={url}
			alt={alt}
			positionKey={positionKey}
		/>
	)
}

// Buffered mode: a whole-buffer download played back from a blob URL. Unlike the streamed path this
// is NEVER size-capped for video/audio (STREAMED_CATEGORIES, preview.logic.ts) — an accepted tradeoff
// of the dev/SW-absent fallback, same as imageViewer.tsx's own buffered path.
function BufferedMedia({ item, category, alt }: { item: DriveItem; category: "video" | "audio"; alt: string }) {
	const result = usePreviewBytes(item)

	if (result.status === "pending") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (result.status === "error") {
		return (
			<PreviewErrorState
				message={errorLabel(result.dto)}
				onRetry={result.refetch}
			/>
		)
	}

	const base = asDirectoryOrFile(item)
	const mime = base.type === "file" ? base.data.decryptedMeta?.mime : undefined

	return (
		<BufferedMediaBytes
			category={category}
			bytes={result.bytes}
			mime={mime}
			alt={alt}
			positionKey={item.data.uuid}
		/>
	)
}

// Picks the SW's inline-preview route (streamed, seekable, uncapped) when a service worker is
// controlling the tab AND this item's mime passes the inline allowlist, else falls back to the
// buffered whole-file blob path (dev / SW absent / a failed stream registration) — mirrors
// imageViewer.tsx's own ImageViewer picker exactly; see previewStream.ts's isMediaStreamAvailable
// for the single capability flip point.
export function MediaViewer({ item, category, alt }: MediaViewerProps) {
	const contentType = allowedMediaContentType(item)
	// An "anon" ambient mode (a public link) can never stream: the service worker's wasm bundle has no
	// UnauthClient, so the buffered path is the only one that serves a logged-out visitor.
	const accessMode = usePreviewAccessMode()
	const streamable = contentType !== null && isMediaStreamAvailable() && accessMode === "authed"
	const [useBuffered, setUseBuffered] = useState(!streamable)

	if (!useBuffered && contentType !== null) {
		return (
			<StreamedMedia
				item={item}
				category={category}
				alt={alt}
				contentType={contentType}
				onFallback={() => {
					setUseBuffered(true)
				}}
			/>
		)
	}

	return (
		<BufferedMedia
			item={item}
			category={category}
			alt={alt}
		/>
	)
}
