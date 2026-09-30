import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/features/drive/lib/item"
import { needsImageTransform } from "@/features/drive/lib/preview.logic"
import { transformHeicBytes } from "@/features/preview/lib/heicTransform"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import { useRawPreview } from "@/features/preview/hooks/useRawPreview"
import { getThumbnailUrl } from "@/features/drive/lib/thumbnails"
// side-effect: registers the generators getThumbnailUrl needs, as useThumbnail.ts does.
import "@/features/drive/lib/thumbGenerators"
import { useObjectUrl } from "@/lib/useObjectUrl"
import { PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { StreamablePreview } from "@/features/preview/components/streamablePreview"
import { type Size, type ZoomTransform, wheelZoom, dragPan, doubleClickZoom } from "@/features/preview/components/imageViewer.logic"

export interface ImageViewerProps {
	item: DriveItem
	alt: string
}

// <img> from an already-resolved URL (streamed, blob or thumbnail). Fit-to-screen via object-contain, plus
// pointer-drag pan while zoomed, double-click zoom toggle, and wheel-zoom-toward-cursor — all pure math
// lives in imageViewer.logic.ts, this component only wires DOM events to it. No pan/zoom library:
// identical rendering regardless of whether `url` is a blob: URL or the SW's inline-preview route.
function ZoomableImage({
	url,
	alt,
	onError
}: {
	url: string
	alt: string
	// Unset on a blob URL, which has nowhere further to fall back to (see RenderPreviewUrl).
	onError?: (() => void) | undefined
}) {
	const [transform, setTransform] = useState<ZoomTransform>({ scale: 1, x: 0, y: 0 })
	const [natural, setNatural] = useState<Size | null>(null)
	const containerRef = useRef<HTMLDivElement | null>(null)
	// Pointerdown-time snapshot: the transform's own x/y right then, plus the pointer's own screen
	// position — every subsequent pointermove computes its delta against THIS, never the previous
	// pointermove's position, so per-event float drift can never accumulate.
	const dragOrigin = useRef<{ x: number; y: number; pointerX: number; pointerY: number } | null>(null)

	// A React onWheel prop can never preventDefault a page scroll here: react-dom registers the wheel
	// listener PASSIVE at its root for scroll performance (verified against the installed react-dom
	// build), so preventDefault silently no-ops inside a synthetic handler. A real, non-passive native
	// listener is the only way to stop the page scrolling under the zoom.
	useEffect(() => {
		const container = containerRef.current

		if (!container) {
			return
		}

		const handleWheel = (event: WheelEvent): void => {
			event.preventDefault()

			const rect = containerRef.current?.getBoundingClientRect()

			if (!rect) {
				return
			}

			const pointerOffset = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
			const containerSize: Size = { width: rect.width, height: rect.height }

			setTransform(prev => wheelZoom(prev, event.deltaY, pointerOffset, containerSize, natural))
		}

		container.addEventListener("wheel", handleWheel, { passive: false })

		return () => {
			container.removeEventListener("wheel", handleWheel)
		}
	}, [natural])

	function handlePointerDown(event: ReactPointerEvent<HTMLImageElement>): void {
		if (transform.scale <= 1) {
			return
		}

		event.currentTarget.setPointerCapture(event.pointerId)
		dragOrigin.current = { x: transform.x, y: transform.y, pointerX: event.clientX, pointerY: event.clientY }
	}

	function handlePointerMove(event: ReactPointerEvent<HTMLImageElement>): void {
		const origin = dragOrigin.current
		const container = containerRef.current

		if (!origin || !container) {
			return
		}

		const rect = container.getBoundingClientRect()
		const delta = { x: event.clientX - origin.pointerX, y: event.clientY - origin.pointerY }

		setTransform(prev => ({
			...prev,
			...dragPan({ x: origin.x, y: origin.y }, delta, prev.scale, { width: rect.width, height: rect.height }, natural)
		}))
	}

	function handlePointerUp(event: ReactPointerEvent<HTMLImageElement>): void {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}

		dragOrigin.current = null
	}

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
				onLoad={event => {
					setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
				}}
				onDoubleClick={() => {
					setTransform(prev => doubleClickZoom(prev))
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				className={`max-h-full max-w-full touch-none object-contain select-none ${transform.scale > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
				style={{ transform: `translate(${String(transform.x)}px, ${String(transform.y)}px) scale(${String(transform.scale)})` }}
			/>
		</div>
	)
}

// Keyed by the buffer itself: a revisited slot gets the same cached Uint8Array back from
// usePreviewBytes, so it skips the decode too, and each JPEG is dropped along with its source bytes.
const heicJpegs = new WeakMap<Uint8Array, Blob>()

// HEIC/HEIF byte stage: pipes the already-downloaded buffer through the lazy-loaded transform and
// mints/revokes a blob URL from the resulting JPEG, mirroring useObjectUrl's lifecycle
// (minting the URL IS the effect; the cleanup revokes it on unmount/bytes-change).
function TransformedImageBytes({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
	const { t } = useTranslation("preview")
	const [state, setState] = useState<{ status: "pending" } | { status: "success"; url: string } | { status: "error" }>({
		status: "pending"
	})
	// Bumped by the error state's own Retry button — `bytes` never changes on a retry (the decoded
	// buffer is already in hand, only the transform itself failed), so a dedicated counter is the only
	// way to re-run the effect below against the SAME input.
	const [retryToken, setRetryToken] = useState(0)

	useEffect(() => {
		let live = true
		let objectUrl: string | null = null

		// Promise handlers, not try/catch: the React Compiler skips a component whose try block holds a
		// conditional or logical expression.
		const cached = heicJpegs.get(bytes)

		void (cached === undefined ? transformHeicBytes(bytes) : Promise.resolve(cached)).then(
			blob => {
				heicJpegs.set(bytes, blob)

				if (!live) {
					return
				}

				objectUrl = URL.createObjectURL(blob)
				setState({ status: "success", url: objectUrl })
			},
			() => {
				if (live) {
					setState({ status: "error" })
				}
			}
		)

		return () => {
			live = false

			if (objectUrl) {
				URL.revokeObjectURL(objectUrl)
			}
		}
	}, [bytes, retryToken])

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.status === "error") {
		return (
			<PreviewErrorState
				message={t("previewTransformFailed")}
				onRetry={() => {
					setState({ status: "pending" })
					setRetryToken(prev => prev + 1)
				}}
			/>
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
// StreamablePreview's buffered path, then hands the bytes to TransformedImageBytes for the decode+re-encode step before
// anything renders.
function TransformedImage({ item, alt }: { item: DriveItem; alt: string }) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<TransformedImageBytes
					bytes={ready.bytes}
					alt={alt}
				/>
			)}
		</PreviewGate>
	)
}

// A Blob already in hand (a RAW's embedded preview).
function BlobImage({ blob, alt }: { blob: Blob; alt: string }) {
	const url = useObjectUrl(blob)

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

// The SDK's documented fallback for a RAW with no usable embedded preview is its thumbnail (made from
// the smaller stamp the SDK still accepts for one). The URL belongs to the thumbnail service's cache,
// so it is never revoked here; if that cache evicts it before the <img> loads, onError drops to the
// labeled state. Anon (public link) skips it: the thumbnail service runs on the authed client only.
function RawThumbnailFallback({ item, alt }: { item: DriveItem; alt: string }) {
	const { t } = useTranslation("preview")
	const accessMode = usePreviewAccessMode()
	const [state, setState] = useState<{ status: "pending" } | { status: "done"; url: string | null }>(
		accessMode === "anon" ? { status: "done", url: null } : { status: "pending" }
	)

	useEffect(() => {
		if (accessMode === "anon") {
			return
		}

		let live = true

		getThumbnailUrl(item).then(
			url => {
				if (live) {
					setState({ status: "done", url })
				}
			},
			() => {
				if (live) {
					setState({ status: "done", url: null })
				}
			}
		)

		return () => {
			live = false
		}
	}, [item, accessMode])

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.url === null) {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
				{t("previewRawNoPreview")}
			</div>
		)
	}

	return (
		<ZoomableImage
			url={state.url}
			alt={alt}
			onError={() => {
				setState({ status: "done", url: null })
			}}
		/>
	)
}

// Camera RAW: no browser decodes the container, so the page shows the JPEG the camera embedded in it,
// extracted by the SDK (useRawPreview). Never the SW route and never a whole-file download.
export function RawImageViewer({ item, alt }: ImageViewerProps) {
	return (
		<PreviewGate result={useRawPreview(item)}>
			{ready =>
				ready.preview.type === "noPreview" ? (
					<RawThumbnailFallback
						item={item}
						alt={alt}
					/>
				) : (
					<BlobImage
						blob={ready.preview.blob}
						alt={alt}
					/>
				)
			}
		</PreviewGate>
	)
}

// Top-level dispatch, hook-free so needsImageTransform can short-circuit before StreamablePreview's own
// useState runs — HEIC/HEIF never reach the streamed branch at all (mediaType.ts independently
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
		<StreamablePreview
			item={item}
			render={(url, onError) => (
				<ZoomableImage
					url={url}
					alt={alt}
					onError={onError}
				/>
			)}
		/>
	)
}
