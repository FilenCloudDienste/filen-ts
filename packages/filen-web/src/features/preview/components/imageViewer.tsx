import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { streamFailureAction, needsImageTransform } from "@/features/drive/lib/preview.logic"
import { transformHeicBytes } from "@/features/preview/lib/heicTransform"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { type ErrorDTO } from "@/lib/sdk/errors"
import { Spinner } from "@/components/ui/spinner"

export interface ImageViewerProps {
	item: DriveItem
	alt: string
}

const MIN_SCALE = 0.25
const MAX_SCALE = 8
// Wheel delta -> scale factor; a typical mouse-wheel notch (~100 deltaY) nudges zoom by ~15%.
const ZOOM_SENSITIVITY = 0.0015

// <img> from an already-resolved URL (either mode below). Fit-to-screen via object-contain, plus a
// basic uniform wheel-zoom (no pan, no lib) — identical rendering regardless of whether `url` is a
// blob: URL or the SW's inline-preview route.
function ZoomableImage({
	url,
	alt,
	onError
}: {
	url: string
	alt: string
	// Only ever wired by the streamed path (StreamedImage below) — the buffered blob path has nowhere
	// further to fall back to, so it leaves this unset and keeps the browser's own native error state.
	onError?: () => void
}) {
	const [scale, setScale] = useState(1)
	const containerRef = useRef<HTMLDivElement | null>(null)

	// A React onWheel prop can never preventDefault a page scroll here: react-dom registers the wheel
	// listener PASSIVE at its root for scroll performance (verified against the installed react-dom
	// build), so preventDefault silently no-ops inside a synthetic handler. A real, non-passive native
	// listener is the only way to stop the page scrolling under the zoom.
	useEffect(() => {
		const container = containerRef.current

		if (!container) {
			return
		}

		function handleWheel(event: WheelEvent): void {
			event.preventDefault()
			setScale(prev => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev - event.deltaY * ZOOM_SENSITIVITY)))
		}

		container.addEventListener("wheel", handleWheel, { passive: false })

		return () => {
			container.removeEventListener("wheel", handleWheel)
		}
	}, [])

	return (
		<div
			ref={containerRef}
			className="flex size-full items-center justify-center overflow-hidden"
		>
			<img
				src={url}
				alt={alt}
				draggable={false}
				onError={onError}
				className="max-h-full max-w-full object-contain select-none"
				style={{ transform: `scale(${String(scale)})` }}
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
function StreamedImage({
	item,
	alt,
	contentType,
	onFallback
}: {
	item: DriveItem
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
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{t("previewStreamFailed")}
			</div>
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
		<ZoomableImage
			url={result.url}
			alt={alt}
			onError={() => {
				// A mid-consumption failure (network drop mid-load, an SW-side decrypt abort, a lifecycle
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

function BufferedImageBytes({ bytes, mime, alt }: { bytes: Uint8Array; mime: string | undefined; alt: string }) {
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		// The generic ArrayBufferLike-vs-ArrayBuffer parameter on Uint8Array (TS lib.es2024.arraybuffer)
		// makes an unparameterized Uint8Array reject BlobPart's stricter ArrayBufferView<ArrayBuffer> —
		// bytes here is always backed by a real ArrayBuffer (Comlink.transfer of a worker download, never
		// a SharedArrayBuffer), so this narrows the generic parameter only, not the value.
		const objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime ?? "application/octet-stream" }))

		// Minting the blob URL IS the side effect (a fresh external-system resource requiring a paired
		// revoke) — there is no value to render until this runs, so it cannot be computed during render. A
		// useMemo/lazy-useState alternative would recompute under StrictMode's double-invoke with no
		// cleanup hook to revoke the discarded first URL, leaking it; this effect's own cleanup below is
		// exactly what makes the double-invoke safe (create/revoke/create, no leak).
		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate, see above
		setUrl(objectUrl)

		return () => {
			URL.revokeObjectURL(objectUrl)
		}
	}, [bytes, mime])

	if (!url) {
		return null
	}

	return (
		<ZoomableImage
			url={url}
			alt={alt}
		/>
	)
}

// Buffered mode (the original whole-buffer behavior, now the fallback): a full-file download,
// minted/revoked as a blob URL entirely in BufferedImageBytes's own effect so the blob never outlives it.
function BufferedImage({ item, alt }: { item: DriveItem; alt: string }) {
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
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{errorLabel(result.dto)}
			</div>
		)
	}

	const base = asDirectoryOrFile(item)
	const mime = base.type === "file" ? base.data.decryptedMeta?.mime : undefined

	return (
		<BufferedImageBytes
			bytes={result.bytes}
			mime={mime}
			alt={alt}
		/>
	)
}

// HEIC/HEIF byte stage: pipes the already-downloaded buffer through the lazy-loaded transform and
// mints/revokes a blob URL from the resulting JPEG, mirroring BufferedImageBytes's own lifecycle
// (minting the URL IS the effect; the cleanup revokes it on unmount/bytes-change).
function TransformedImageBytes({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
	const { t } = useTranslation("preview")
	const [state, setState] = useState<{ status: "pending" } | { status: "success"; url: string } | { status: "error"; dto: ErrorDTO }>({
		status: "pending"
	})

	useEffect(() => {
		let live = true
		let objectUrl: string | null = null

		async function run(): Promise<void> {
			try {
				const blob = await transformHeicBytes(bytes)

				if (!live) {
					return
				}

				objectUrl = URL.createObjectURL(blob)
				setState({ status: "success", url: objectUrl })
			} catch {
				if (live) {
					const message = t("previewTransformFailed")

					setState({ status: "error", dto: { species: "plain", message, label: message } })
				}
			}
		}

		void run()

		return () => {
			live = false

			if (objectUrl) {
				URL.revokeObjectURL(objectUrl)
			}
		}
	}, [bytes, t])

	if (state.status === "pending") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (state.status === "error") {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{errorLabel(state.dto)}
			</div>
		)
	}

	return (
		<ZoomableImage
			url={state.url}
			alt={alt}
		/>
	)
}

// HEIC/HEIF: never streamable (needsImageTransform), always buffered — downloads the whole file like
// BufferedImage, then hands the bytes to TransformedImageBytes for the decode+re-encode step before
// anything renders.
function TransformedImage({ item, alt }: { item: DriveItem; alt: string }) {
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
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{errorLabel(result.dto)}
			</div>
		)
	}

	return (
		<TransformedImageBytes
			bytes={result.bytes}
			alt={alt}
		/>
	)
}

// Picks the SW's inline-preview route (streamed, no whole-buffer download) when a service worker is
// controlling the tab AND this item's mime passes the inline allowlist, else falls back to the
// buffered whole-file blob path (dev / SW absent / a failed stream registration) — see
// preview-stream.ts's isMediaStreamAvailable for the single capability flip point. The buffered path
// is also where an item the allowlist rejects outright (e.g. an unrecognized mime) always lands.
function StreamableImage({ item, alt }: { item: DriveItem; alt: string }) {
	const contentType = allowedMediaContentType(item)
	const streamable = contentType !== null && isMediaStreamAvailable()
	const [useBuffered, setUseBuffered] = useState(!streamable)

	if (!useBuffered && contentType !== null) {
		return (
			<StreamedImage
				item={item}
				alt={alt}
				contentType={contentType}
				onFallback={() => {
					setUseBuffered(true)
				}}
			/>
		)
	}

	return (
		<BufferedImage
			item={item}
			alt={alt}
		/>
	)
}

// Top-level dispatch, hook-free so needsImageTransform can short-circuit before StreamableImage's own
// useState runs — HEIC/HEIF never reach the streamed branch at all (media-type.ts independently
// excludes them too, defense-in-depth), every other image extension is unaffected.
export function ImageViewer({ item, alt }: ImageViewerProps) {
	if (needsImageTransform(item)) {
		return (
			<TransformedImage
				item={item}
				alt={alt}
			/>
		)
	}

	return (
		<StreamableImage
			item={item}
			alt={alt}
		/>
	)
}
