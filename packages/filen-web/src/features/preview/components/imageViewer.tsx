import { useEffect, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/features/drive/lib/item"
import { imageDecodeFor, imageMupdfFormat, needsImageTransform, pendingImageProbe } from "@/features/drive/lib/preview.logic"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import type { DeviceProfile } from "@/lib/deviceProfile"
import type { PreviewKey } from "@/lib/i18n"
import { probeNativeImage } from "@/lib/nativeImageSupport"
import { transformHeicBytes } from "@/features/preview/lib/rasterDecode"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import { useRawPreview } from "@/features/preview/hooks/useRawPreview"
import { getThumbnailUrl } from "@/features/drive/lib/thumbnails"
// side-effect: registers the generators getThumbnailUrl needs, as useThumbnail.ts does.
import "@/features/drive/lib/thumbGenerators"
import { PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { StreamablePreview } from "@/features/preview/components/streamablePreview"
import { BlobImage, ZoomableImage } from "@/features/preview/components/zoomableImage"
import { DecodedImage, HeldImageGate, SvgzImage } from "@/features/preview/components/decodedImage"
import { MupdfImage } from "@/features/preview/components/mupdfImage"
import { EpsImage } from "@/features/preview/components/epsImage"
import { NativeSizeGate } from "@/features/preview/components/nativeSizeGate"
import { AnimatableImage } from "@/features/preview/components/animatedImagePlayer"
import { NATIVE_VIEW_SNIFF_FROM_BYTES, nativeViewCrash } from "@/lib/pixelBudget"
import type { ImagePageSlot } from "@/features/preview/lib/imagePageSource"

export interface ImageViewerProps {
	item: DriveItem
	alt: string
	// Holds the shown <img> while it is mounted, for the image editor to take its decoded pixels instead of fetching
	// the file again. Not set for HEIC/HEIF (the editor decodes those itself).
	imageRef?: RefObject<HTMLImageElement | null> | undefined
	// Holds the page shown by a document engine (a TIFF's), for the image editor to draw from it.
	pageSourceRef?: RefObject<ImagePageSlot | null> | undefined
}

// Keyed by the buffer itself: a revisited slot gets the same cached Uint8Array back from
// usePreviewBytes, so it skips the decode too, and each JPEG is dropped along with its source bytes.
const heicJpegs = new WeakMap<Uint8Array, Blob>()

// HEIC/HEIF byte stage: pipes the already-downloaded buffer through the HEIC worker's transform and
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
		// Aborted on unmount, so a transform still waiting for the worker is never posted.
		const gone = new AbortController()
		let objectUrl: string | null = null

		// Promise handlers, not try/catch: the React Compiler skips a component whose try block holds a
		// conditional or logical expression.
		const cached = heicJpegs.get(bytes)

		void (cached === undefined ? transformHeicBytes(bytes, gone.signal) : Promise.resolve(cached)).then(
			blob => {
				heicJpegs.set(bytes, blob)

				if (gone.signal.aborted) {
					return
				}

				objectUrl = URL.createObjectURL(blob)
				setState({ status: "success", url: objectUrl })
			},
			() => {
				if (!gone.signal.aborted) {
					setState({ status: "error" })
				}
			}
		)

		return () => {
			gone.abort()

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

// HEIC/HEIF decoded by libheif (needsImageTransform, or a native decode that failed): downloads the whole file like
// StreamablePreview's buffered path, then hands the bytes to TransformedImageBytes for the decode+re-encode step before
// anything renders. Nothing above the held-image cap is loaded whole, and `tooLarge` says why (a native picture
// admitted at any size may land here once its decode failed).
function TransformedImage({ item, alt, tooLarge }: { item: DriveItem; alt: string; tooLarge: PreviewKey }) {
	return (
		<HeldImageGate
			item={item}
			tooLarge={tooLarge}
		>
			<TransformedImageLoad
				item={item}
				alt={alt}
			/>
		</HeldImageGate>
	)
}

function TransformedImageLoad({ item, alt }: { item: DriveItem; alt: string }) {
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

		// Closing the preview withdraws this interest like an unmounted tile does, so a generation nothing
		// shows any more is not kept alive by it.
		const controller = new AbortController()

		getThumbnailUrl(item, undefined, controller.signal).then(
			url => {
				if (!controller.signal.aborted) {
					setState({ status: "done", url })
				}
			},
			() => {
				if (!controller.signal.aborted) {
					setState({ status: "done", url: null })
				}
			}
		)

		return () => {
			controller.abort()
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

// How an image is shown: as the browser decodes it (streamed, or from its buffered fallback), decoded by our own code
// first, or decoded by our own code after the browser failed to decode the whole file.
type ImageRoute = "native" | "decoded" | "undecodable"

function routeFor(item: DriveItem, profile: DeviceProfile): ImageRoute {
	return needsImageTransform(item, profile) ? "decoded" : "native"
}

// The decoded route: the format's own decoder.
function DecodedRoute({
	item,
	alt,
	route,
	pageSourceRef
}: {
	item: DriveItem
	alt: string
	route: Exclude<ImageRoute, "native">
	pageSourceRef: ImageViewerProps["pageSourceRef"]
}) {
	const decode = imageDecodeFor(item)

	const mupdf = imageMupdfFormat(item)

	if (mupdf !== null) {
		return (
			<MupdfImage
				item={item}
				alt={alt}
				format={mupdf}
				pageSourceRef={pageSourceRef}
			/>
		)
	}

	if (decode === "eps") {
		return (
			<EpsImage
				item={item}
				alt={alt}
			/>
		)
	}

	if (decode === "svgz") {
		return (
			<SvgzImage
				item={item}
				alt={alt}
			/>
		)
	}

	if (decode === "qoi" || decode === "jxl") {
		return (
			<DecodedImage
				item={item}
				alt={alt}
				format={decode}
			/>
		)
	}

	return (
		<TransformedImage
			item={item}
			alt={alt}
			tooLarge={route === "undecodable" ? "previewImageNotDisplayable" : "previewTooLargeToShowHere"}
		/>
	)
}

// Top-level dispatch: needsImageTransform short-circuits before StreamablePreview's own useState runs — an image this
// browser does not decode itself never reaches the streamed branch (mediaType.ts excludes it too, defense-in-depth),
// every other image extension is unaffected. One opened before the boot probe answered waits for its answer (a
// decode of a few hundred bytes) rather than take the decoded route an unknown answer reads as. The route is then
// picked once per file: a probe that refines the device profile while it is open changes the next open, never this one
// (which would drop the decoded picture, its zoom, and download it again).
export function ImageViewer({ item, alt, imageRef, pageSourceRef }: ImageViewerProps) {
	const profile = useDeviceProfile()
	const uuid = item.data.uuid
	const probe = pendingImageProbe(item, profile)
	const [route, setRoute] = useState<{ uuid: string; route: ImageRoute } | null>(() =>
		probe === null ? { uuid, route: routeFor(item, profile) } : null
	)
	let current = route?.uuid === uuid ? route.route : null

	if (current === null && probe === null) {
		current = routeFor(item, profile)
		setRoute({ uuid, route: current })
	}

	useEffect(() => {
		if (probe !== null) {
			void probeNativeImage(probe)
		}
	}, [probe])

	if (current === null) {
		return <PreviewLoading />
	}

	if (current !== "native") {
		return (
			<DecodedRoute
				item={item}
				alt={alt}
				route={current}
				pageSourceRef={pageSourceRef}
			/>
		)
	}

	const decode = imageDecodeFor(item)
	const native = (
		<StreamablePreview
			item={item}
			// A format with a decoder of our own that the browser received whole and could not decode goes to that decoder,
			// on the bytes already held where they are.
			onDecodeFailure={
				decode !== null && decode !== "native"
					? () => {
							setRoute({ uuid, route: "undecodable" })
						}
					: undefined
			}
			// An animation the browser's ImageDecoder plays gets the animated image player.
			render={(url, onError) => (
				<AnimatableImage
					item={item}
					url={url}
					alt={alt}
				>
					<ZoomableImage
						url={url}
						alt={alt}
						onError={onError}
						imageRef={imageRef}
					/>
				</AnimatableImage>
			)}
		/>
	)
	// Where the browser's own decode has a pixel cap (a phone), a file large enough to pass it is sized from its head
	// first.
	const cap = nativeViewCrash(profile)

	return cap !== null && Number(item.data.size) >= NATIVE_VIEW_SNIFF_FROM_BYTES ? (
		<NativeSizeGate
			item={item}
			cap={cap}
		>
			{native}
		</NativeSizeGate>
	) : (
		native
	)
}
