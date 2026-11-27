import { useEffect, useEffectEvent, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { driveItemMime, type DriveItem } from "@/features/drive/lib/item"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import {
	isMediaStreamAvailable,
	onMediaStreamAvailable,
	previewDeliveredAfterError,
	previewStreamIdOf,
	waitForMediaStream
} from "@/features/preview/lib/previewStream"
import { bufferedSizeCap, previewType, streamFailureAction } from "@/features/drive/lib/preview.logic"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { usePreviewCacheScope, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import { originRanged } from "@/lib/sdk/byteOrigin"
import { useObjectUrl } from "@/lib/useObjectUrl"
import {
	PreviewDownloadButton,
	PreviewErrorState,
	PreviewGate,
	PreviewLoading,
	PreviewUnsupportedState
} from "@/features/preview/components/previewErrorState"

// Renders the image for a resolved URL; `onError` takes the <img> that failed. It is set on the streamed path, and on
// the buffered one only where a decode failure has somewhere to go (onDecodeFailure): otherwise the blob path keeps
// the browser's own error state. Video and audio never come here: they always stream (mediaViewer.tsx).
export type RenderPreviewUrl = (url: string, onError: ((image: HTMLImageElement) => void) | undefined) => ReactNode

// Streamed mode: registers against the SW's inline route and renders once a URL resolves. A
// registration failure hands control back to the parent (onFallback) for the buffered fallback ONLY
// when the file is under the whole-buffer cap (streamFailureAction, the SAME decision the mid-
// consumption onError handler below applies) — an oversize file gets the labeled error state instead,
// never an unbounded buffered retry (a huge image on a prod SW hiccup would otherwise whole-buffer
// straight into a tab-crashing allocation, since a streamed category is never capped at the open gate,
// preview.logic.ts).
//
// With `onDecodeFailure`, an <img> error is first classified: no pixels after the worker acknowledged every byte
// (SW_MSG_PREVIEW_DELIVERED) is the browser failing to decode the file, which a retry of the same bytes cannot change,
// so it goes there; anything else (no acknowledgement: the bytes never all arrived) takes the path above. Such an image
// registers under an id of its own each time: a URL the browser answers from its memory cache sends no new
// acknowledgement.
function StreamedPreview({
	item,
	contentType,
	onFallback,
	onDecodeFailure,
	render
}: {
	item: DriveItem
	contentType: string
	onFallback: () => void
	onDecodeFailure: (() => void) | undefined
	render: RenderPreviewUrl
}) {
	const { t } = useTranslation("preview")
	const name = driveItemName(item)
	const result = usePreviewStreamUrl(item, name, contentType, { fresh: onDecodeFailure !== undefined })
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
				action={<PreviewDownloadButton />}
			/>
		)
	}

	if (result.status !== "success") {
		return <PreviewLoading />
	}

	const url = result.url

	// A mid-consumption failure (network drop mid-load/seek, an SW-side decrypt abort, a lifecycle
	// hiccup) — unlike the registration-failure effect above, retrying buffered here would
	// re-download the whole file, so an oversize item gets the labeled error instead.
	function streamFailed(): void {
		if (streamFailureAction(item) === "buffer") {
			onFallback()
		} else {
			setCapExceeded(true)
		}
	}

	return render(url, image => {
		if (onDecodeFailure === undefined) {
			streamFailed()

			return
		}

		const blank = image.naturalWidth === 0

		void previewDeliveredAfterError(previewStreamIdOf(url)).then(delivered => {
			if (delivered && blank) {
				onDecodeFailure()
			} else {
				streamFailed()
			}
		})
	})
}

function BufferedPreviewBytes({
	bytes,
	mime,
	onDecodeFailure,
	render
}: {
	bytes: Uint8Array
	mime: string | undefined
	onDecodeFailure: (() => void) | undefined
	render: RenderPreviewUrl
}) {
	const url = useObjectUrl(bytes, mime)

	if (!url) {
		return null
	}

	// Bytes in hand failed to decode: nothing to retry, and the fallback decodes the same held bytes.
	return render(
		url,
		onDecodeFailure === undefined
			? undefined
			: () => {
					onDecodeFailure()
				}
	)
}

// Buffered mode: a whole-file download played back from a blob URL, minted/revoked by useObjectUrl so
// the blob never outlives it. The open gate does not cap a streamed image (CATEGORY_POLICY, preview.logic.ts), so
// StreamablePreview mounts this only at or below the category's buffer cap.
function BufferedPreview({
	item,
	onDecodeFailure,
	render
}: {
	item: DriveItem
	onDecodeFailure: (() => void) | undefined
	render: RenderPreviewUrl
}) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<BufferedPreviewBytes
					bytes={ready.bytes}
					mime={driveItemMime(item)}
					onDecodeFailure={onDecodeFailure}
					render={render}
				/>
			)}
		</PreviewGate>
	)
}

// A file too large to load whole that could stream once a service worker controls the page (the ordinary state for a
// moment after an install or update): streams if one takes control, else says the file is too large to show here, and
// still streams once one takes control later while it is shown.
function AwaitStream({ item, onStream }: { item: DriveItem; onStream: () => void }) {
	const { t } = useTranslation("preview")
	const [unavailable, setUnavailable] = useState(false)
	const stream = useEffectEvent(onStream)

	useEffect(() => {
		let live = true

		const stop = onMediaStreamAvailable(() => {
			if (live) {
				stream()
			}
		})

		void waitForMediaStream().then(available => {
			if (!live) {
				return
			}

			if (available) {
				stream()
			} else {
				setUnavailable(true)
			}
		})

		return () => {
			live = false
			stop()
		}
	}, [])

	if (unavailable) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewTooLargeToShowHere")}
			/>
		)
	}

	return <PreviewLoading />
}

// Picks the SW's inline-preview route (streamed, seekable, no whole-buffer download) when a service
// worker is controlling the tab AND this item's mime passes the inline allowlist, else falls back to
// the buffered whole-file blob path (dev / SW absent / a failed stream registration) — see
// previewStream.ts's isMediaStreamAvailable for the single capability flip point. The buffered path is
// also where an item the allowlist rejects outright (e.g. an unrecognized mime) always lands, but never above the
// category's buffer cap: such a file waits for a service worker when it could stream, else says it is too large.
// `onDecodeFailure` is where an image goes when the browser received it whole and could not decode it (a format with a
// decoder of our own); without it, every failure takes the stream's retry path.
export function StreamablePreview({
	item,
	onDecodeFailure,
	render
}: {
	item: DriveItem
	onDecodeFailure?: (() => void) | undefined
	render: RenderPreviewUrl
}) {
	const { t } = useTranslation("preview")
	const profile = useDeviceProfile()
	const contentType = allowedMediaContentType(item, profile)
	// A drive file streams through the service worker's own session read, a public link's file through the SDK
	// worker's unauthenticated range port, and an archive's entry read by range through the SDK worker's port. Bytes
	// read whole never stream.
	const origin = usePreviewOrigin(item)
	const cacheScope = usePreviewCacheScope()
	const canStream =
		contentType !== null &&
		(origin.kind === "file" || origin.kind === "linkedFile" || (origin.kind === "entry" && originRanged(origin)))
	// Bytes already held (a revisited buffered slot, an edited image just saved) show from memory: streaming them
	// would download the file again.
	const held = getPreviewBytes(cacheScope, item.data.uuid) !== undefined
	const [useBuffered, setUseBuffered] = useState(() => !canStream || !isMediaStreamAvailable() || held)
	const cap = bufferedSizeCap(previewType(item), profile)

	if (!useBuffered && contentType !== null) {
		return (
			<StreamedPreview
				item={item}
				contentType={contentType}
				onFallback={() => {
					setUseBuffered(true)
				}}
				onDecodeFailure={onDecodeFailure}
				render={render}
			/>
		)
	}

	if (!held && cap !== null && item.data.size > cap) {
		return canStream ? (
			<AwaitStream
				item={item}
				onStream={() => {
					setUseBuffered(false)
				}}
			/>
		) : (
			<PreviewUnsupportedState
				item={item}
				message={t("previewTooLargeToShowHere")}
			/>
		)
	}

	return (
		<BufferedPreview
			item={item}
			onDecodeFailure={onDecodeFailure}
			render={render}
		/>
	)
}
