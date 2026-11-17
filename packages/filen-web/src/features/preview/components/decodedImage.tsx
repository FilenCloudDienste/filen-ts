import { useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { DriveItem } from "@/features/drive/lib/item"
import { heldImageCap } from "@/features/drive/lib/preview.logic"
import type { PreviewKey } from "@/lib/i18n"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { canvasPixels, displayLongSide, workerDecodePixels } from "@/lib/pixelBudget"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import { displayRaster, RASTER_BYTES_PER_PIXEL } from "@/features/preview/lib/rasterDecode"
import { rasterHeader } from "@/features/preview/lib/imageSniff/raster"
import type { DisplayRasterFormat } from "@/features/preview/lib/rasterCodecs/raster"
import { fullResolution } from "@/features/preview/lib/rasterCodecs/display"
import { PreviewGate, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { BitmapImage, BlobImage } from "@/features/preview/components/zoomableImage"
import { gunzipSvg } from "@/features/preview/lib/svgz"
import { Button } from "@/components/ui/button"

// An image held whole to decode it ourselves: nothing above its held cap is loaded (bytes already held decode at any
// size), and `tooLarge` says why.
export function HeldImageGate({ item, tooLarge, children }: { item: DriveItem; tooLarge: PreviewKey; children: ReactNode }) {
	const { t } = useTranslation("preview")
	const cap = heldImageCap(item, useDeviceProfile())
	const held = getPreviewBytes(usePreviewCacheScope(), item.data.uuid) !== undefined

	if (!held && cap !== null && item.data.size > cap) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t(tooLarge)}
			/>
		)
	}

	return children
}

// An image our own code decodes (QOI, a JPEG XL the browser does not): its whole bytes, decoded in the raster decode pool into a bitmap shown at
// the display long side, its full resolution a click away.
export function DecodedImage({ item, alt, format }: { item: DriveItem; alt: string; format: DisplayRasterFormat }) {
	return (
		<HeldImageGate
			item={item}
			tooLarge="previewTooLargeToShowHere"
		>
			<DecodedImageLoad
				item={item}
				alt={alt}
				format={format}
			/>
		</HeldImageGate>
	)
}

function DecodedImageLoad({ item, alt, format }: { item: DriveItem; alt: string; format: DisplayRasterFormat }) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<DecodedImageBytes
					item={item}
					bytes={ready.bytes}
					alt={alt}
					format={format}
				/>
			)}
		</PreviewGate>
	)
}

type Shown =
	| { readonly status: "pending" }
	| { readonly status: "failed" }
	| { readonly status: "shown"; readonly bitmap: ImageBitmap; readonly width: number; readonly height: number }

// One whose bytes are in hand (an EPS file's preview section).
export function DecodedImageBytes({
	item,
	bytes,
	alt,
	format
}: {
	item: DriveItem
	bytes: Uint8Array
	alt: string
	format: DisplayRasterFormat
}) {
	const { t } = useTranslation("preview")
	const profile = useDeviceProfile()
	const header = rasterHeader(format, bytes)
	const naturalWidth = header?.width ?? 0
	const naturalHeight = header?.height ?? 0
	const maxPixels = workerDecodePixels(profile, bytes.byteLength, RASTER_BYTES_PER_PIXEL[format])
	const fits = header !== null && naturalWidth * naturalHeight <= maxPixels
	const longSide = displayLongSide(profile)
	// Never larger than a canvas of this device holds.
	const full = header === null ? null : fullResolution(naturalWidth, naturalHeight, longSide, canvasPixels())
	const fullLongSide = full === null ? longSide : Math.max(full.width, full.height)
	// The decode asked for (the bytes it decodes, and whether at full resolution) with what it gave: a result for other
	// bytes is not this one's. A full-resolution draw that failed keeps the reduced one, and is not offered again.
	const [wanted, setWanted] = useState<{ bytes: Uint8Array; full: boolean; failed: boolean }>({ bytes, full: false, failed: false })
	const atFull = wanted.bytes === bytes && wanted.full
	const fullFailed = wanted.bytes === bytes && wanted.failed
	const [shown, setShown] = useState<{ bytes: Uint8Array; shown: Shown }>({ bytes, shown: { status: "pending" } })

	useEffect(() => {
		if (!fits) {
			return
		}

		const controller = new AbortController()

		displayRaster(format, bytes, { maxPixels, maxLongSide: atFull ? fullLongSide : longSide, signal: controller.signal }).then(
			result => {
				if (controller.signal.aborted) {
					result.bitmap.close()

					return
				}

				setShown({
					bytes,
					shown: { status: "shown", bitmap: result.bitmap, width: result.bitmap.width, height: result.bitmap.height }
				})
			},
			() => {
				if (controller.signal.aborted) {
					return
				}

				// The reduced view stays: the full one is not asked again.
				if (atFull) {
					setWanted({ bytes, full: true, failed: true })
					toast.error(t("previewImageFullFailed"))

					return
				}

				setShown({ bytes, shown: { status: "failed" } })
			}
		)

		return () => {
			controller.abort()
		}
	}, [bytes, format, fits, maxPixels, longSide, fullLongSide, atFull, t])

	if (header === null) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewImageNotDisplayable")}
			/>
		)
	}

	if (!fits) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewImageTooLarge")}
			/>
		)
	}

	const current: Shown = shown.bytes === bytes ? shown.shown : { status: "pending" }

	if (current.status === "pending") {
		return <PreviewLoading />
	}

	if (current.status === "failed") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewImageDecodeFailed")}
			/>
		)
	}

	return (
		<div className="relative size-full">
			<BitmapImage
				bitmap={current.bitmap}
				width={current.width}
				height={current.height}
				alt={alt}
			/>
			{full !== null && !atFull && !fullFailed ? (
				<ReducedChip
					width={naturalWidth}
					height={naturalHeight}
					onShowFull={() => {
						setWanted({ bytes, full: true, failed: false })
					}}
				/>
			) : null}
		</div>
	)
}

// Shown over an image drawn below its own resolution: its real size, and the way to draw it whole.
export function ReducedChip({ width, height, onShowFull }: { width: number; height: number; onShowFull: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<div className="absolute top-3 left-3 flex items-center gap-1 rounded-full bg-background/80 py-0.5 pr-0.5 pl-3 text-xs text-muted-foreground tabular-nums shadow-sm backdrop-blur-sm">
			<span>{t("previewImageReduced", { width, height })}</span>
			<Button
				variant="ghost"
				size="xs"
				className="rounded-full text-foreground"
				onClick={onShowFull}
			>
				{t("previewImageShowFull")}
			</Button>
		</div>
	)
}

// The most an SVG may inflate to in the preview: the compressed file's own cap.
const SVGZ_INFLATED_MAX = 32 * 1024 * 1024

// A gzipped SVG: its whole bytes (32 MiB at most), inflated by the browser's gzip and stopped past 32 MiB, then shown
// as an SVG through a blob <img>, which runs no script and fetches nothing.
export function SvgzImage({ item, alt }: { item: DriveItem; alt: string }) {
	return (
		<HeldImageGate
			item={item}
			tooLarge="previewTooLargeToShowHere"
		>
			<SvgzImageLoad
				item={item}
				alt={alt}
			/>
		</HeldImageGate>
	)
}

function SvgzImageLoad({ item, alt }: { item: DriveItem; alt: string }) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<SvgzImageBytes
					item={item}
					bytes={ready.bytes}
					alt={alt}
				/>
			)}
		</PreviewGate>
	)
}

type Inflated =
	| { readonly status: "pending" }
	| { readonly status: "tooLarge" }
	| { readonly status: "failed" }
	| { readonly status: "shown"; readonly blob: Blob }

function SvgzImageBytes({ item, bytes, alt }: { item: DriveItem; bytes: Uint8Array; alt: string }) {
	const { t } = useTranslation("preview")
	const [inflated, setInflated] = useState<{ bytes: Uint8Array; inflated: Inflated }>({ bytes, inflated: { status: "pending" } })

	useEffect(() => {
		let live = true

		gunzipSvg(bytes, SVGZ_INFLATED_MAX).then(
			blob => {
				if (live) {
					setInflated({ bytes, inflated: blob === null ? { status: "tooLarge" } : { status: "shown", blob } })
				}
			},
			() => {
				if (live) {
					setInflated({ bytes, inflated: { status: "failed" } })
				}
			}
		)

		return () => {
			live = false
		}
	}, [bytes])

	const current: Inflated = inflated.bytes === bytes ? inflated.inflated : { status: "pending" }

	switch (current.status) {
		case "pending":
			return <PreviewLoading />
		case "tooLarge":
			return (
				<PreviewUnsupportedState
					item={item}
					message={t("previewSvgzTooLarge")}
				/>
			)
		case "failed":
			return (
				<PreviewUnsupportedState
					item={item}
					message={t("previewImageDecodeFailed")}
				/>
			)
		case "shown":
			return (
				<BlobImage
					blob={current.blob}
					alt={alt}
				/>
			)
	}
}
