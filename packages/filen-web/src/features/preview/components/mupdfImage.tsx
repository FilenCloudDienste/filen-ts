import { useEffect, useEffectEvent, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PdfEngineError } from "@filen/office/dom/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PreviewKey } from "@/lib/i18n"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { canvasPixels, displayLongSide } from "@/lib/pixelBudget"
import { originKey, originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { mupdfImagePixels, openMupdfReader, type MupdfReader } from "@/lib/mupdf/reader"
import { openByteReader } from "@/features/preview/lib/origin/byteReader"
import { sniffTiff } from "@/features/preview/lib/imageSniff/tiff"
import { sniffPsd } from "@/features/preview/lib/imageSniff/psd"
import { fitLongSide, fullResolution } from "@/features/preview/lib/rasterCodecs/display"
import { readerPageSource, type ImagePageSlot, type ImagePageSource } from "@/features/preview/lib/imagePageSource"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { BitmapImage } from "@/features/preview/components/zoomableImage"
import { HeldImageGate, ReducedChip } from "@/features/preview/components/decodedImage"
import { PdfReaderShell } from "@/features/preview/components/pdfReaderShell"
import { usePreviewAccessMode, usePreviewCacheScope, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { log } from "@/lib/log"

// A TIFF or a Photoshop file, read by the MuPDF read role in an engine of its own (sign-out and unmount end it): one
// page (a Photoshop file's flattened composite) drawn whole as a bitmap at the display long side, its full resolution a
// click away; a TIFF's several pages in the shared PDF reader, with no find (an image has no text). Its header is read
// first, so what the engine does not read (a BigTIFF, a Large Document Format file, a Photoshop colour mode or depth it
// has no decoder for) and a first page larger than the engine's pixel budget are refused before any engine starts.

// The head every TIFF and Photoshop header (and, usually, a TIFF's first IFD) sits in.
const HEAD_BYTES = 64 * 1024

// The Photoshop colour modes the engine composites (greyscale, RGB, CMYK), at 8 or 16 bits a channel.
const PSD_MODES: ReadonlySet<number> = new Set([1, 3, 4])
const PSD_DEPTHS: ReadonlySet<number> = new Set([8, 16])

export type MupdfImageFormat = "tiff" | "psd"

type Opened =
	| { readonly status: "refused"; readonly message: PreviewKey }
	| { readonly status: "failed" }
	| { readonly status: "open"; readonly reader: MupdfReader }

export interface MupdfImageProps {
	item: DriveItem
	alt: string
	format: MupdfImageFormat
	// Holds the page shown while it is mounted, for the image editor to draw from the engine that holds the file.
	pageSourceRef?: RefObject<ImagePageSlot | null> | undefined
	// Bytes to read instead of the item's own (an EPS file's TIFF preview section).
	source?: ByteOrigin | undefined
}

export function MupdfImage(props: MupdfImageProps) {
	return (
		<HeldImageGate
			item={props.item}
			tooLarge="previewTooLargeToShowHere"
		>
			<MupdfDocument {...props} />
		</HeldImageGate>
	)
}

// The refusals the engine's own answers stand for; null for a failure worth a retry.
function refusalOf(error: unknown): PreviewKey | null {
	if (!(error instanceof PdfEngineError)) {
		return null
	}

	switch (error.failure) {
		case "overBudget":
			return "previewImageTooLarge"
		// A Photoshop file saved without its composite ("Maximize compatibility" off), or with a deflated one.
		case "notSupported":
			return /Unflattened|Deflate/u.test(error.message) ? "previewPsdNoComposite" : "previewImageNotDisplayable"
		default:
			return null
	}
}

// Why the header in `head` says the engine cannot show the file, or how large its first page is (null: unknown).
function headerVerdict(
	format: MupdfImageFormat,
	head: Uint8Array,
	size: number
): { readonly refused: PreviewKey } | { readonly pixels: number | null } {
	if (format === "psd") {
		const psd = sniffPsd(head, size)

		if (psd === null) {
			return { refused: "previewImageNotDisplayable" }
		}

		if (psd.version === 2) {
			return { refused: "previewPsbUnsupported" }
		}

		return PSD_MODES.has(psd.mode) && PSD_DEPTHS.has(psd.depth)
			? { pixels: psd.width * psd.height }
			: { refused: "previewImageNotDisplayable" }
	}

	const tiff = sniffTiff(head, size)

	if (tiff === null) {
		return { refused: "previewImageNotDisplayable" }
	}

	if (tiff.kind === "bigTiff") {
		return { refused: "previewBigTiffUnsupported" }
	}

	// A first page past the head is checked by the engine from its header, before it is drawn.
	return { pixels: tiff.size === null ? null : tiff.size.width * tiff.size.height }
}

async function openMupdfImage(
	format: MupdfImageFormat,
	origin: ByteOrigin,
	access: OriginAccess,
	scope: string | null,
	profile: DeviceProfile,
	signal: AbortSignal
): Promise<Opened> {
	const head = await openByteReader(origin, crypto.randomUUID(), { access, blocks: 1 }).then(async reader => {
		try {
			return await reader.read(0, HEAD_BYTES, signal)
		} finally {
			reader.close()
		}
	})
	const verdict = headerVerdict(format, head, originSize(origin))

	if ("refused" in verdict) {
		return { status: "refused", message: verdict.refused }
	}

	const maxImagePixels = mupdfImagePixels(profile, origin, format)

	if (verdict.pixels !== null && verdict.pixels > maxImagePixels) {
		return { status: "refused", message: "previewImageTooLarge" }
	}

	return { status: "open", reader: await openMupdfReader({ origin, access, scope, format, maxImagePixels, signal }) }
}

export function MupdfDocument({ item, alt, format, pageSourceRef, source }: MupdfImageProps) {
	const { t } = useTranslation("preview")
	const own = usePreviewOrigin(item)
	const origin = source ?? own
	const access = usePreviewAccessMode()
	const scope = usePreviewCacheScope()
	const profile = useDeviceProfile()
	const [attempt, setAttempt] = useState(0)
	const key = `${originKey(origin)}:${String(attempt)}`
	const [opened, setOpened] = useState<{ key: string; opened: Opened } | null>(null)
	const latest = useEffectEvent(() => ({ origin, profile }))

	useEffect(() => {
		const controller = new AbortController()
		let reader: MupdfReader | null = null
		const { origin: current, profile: now } = latest()
		// The editor asked meanwhile waits for this engine (its first page) rather than open one of its own.
		let settle: (page: ImagePageSource | null) => void = () => undefined
		const slot: ImagePageSlot = {
			opening: new Promise<ImagePageSource | null>(resolve => {
				settle = resolve
			})
		}

		if (pageSourceRef !== undefined) {
			pageSourceRef.current = slot
		}

		openMupdfImage(format, current, access, scope, now, controller.signal).then(
			result => {
				if (controller.signal.aborted) {
					if (result.status === "open") {
						void result.reader.close()
					}

					return
				}

				if (result.status === "open") {
					reader = result.reader
				}

				settle(result.status === "open" ? readerPageSource(result.reader, 0) : null)
				setOpened({ key, opened: result })
			},
			(error: unknown) => {
				settle(null)

				if (controller.signal.aborted) {
					return
				}

				const refusal = refusalOf(error)

				if (refusal === null) {
					log.warn("preview", "opening an image in the read role failed", error)
				}

				setOpened({ key, opened: refusal === null ? { status: "failed" } : { status: "refused", message: refusal } })
			}
		)

		return () => {
			controller.abort()
			settle(null)

			if (pageSourceRef?.current === slot) {
				pageSourceRef.current = null
			}

			void reader?.close()
		}
	}, [key, format, access, scope, pageSourceRef])

	const current = opened?.key === key ? opened.opened : null

	if (current === null) {
		return <PreviewLoading />
	}

	switch (current.status) {
		case "refused":
			return (
				<PreviewUnsupportedState
					item={item}
					message={t(current.message)}
				/>
			)
		case "failed":
			return (
				<PreviewErrorState
					message={t("previewImageDecodeFailed")}
					onRetry={() => {
						setAttempt(value => value + 1)
					}}
				/>
			)
		case "open":
			return current.reader.pageCount > 1 ? (
				<TiffPages
					item={item}
					alt={alt}
					// The bytes read: an EPS file's TIFF section, not the whole file.
					size={origin.kind === "bytes" ? origin.blob.size : Number(item.data.size)}
					reader={current.reader}
					pageSourceRef={pageSourceRef}
				/>
			) : (
				<TiffPage
					item={item}
					alt={alt}
					reader={current.reader}
					pageSourceRef={pageSourceRef}
				/>
			)
	}
}

type Drawn =
	| { readonly status: "pending" }
	| { readonly status: "refused"; readonly message: PreviewKey }
	| {
			readonly status: "shown"
			readonly bitmap: ImageBitmap
			readonly width: number
			readonly height: number
			readonly natural: { readonly width: number; readonly height: number } | null
	  }

// The one page, drawn whole at the display long side (its own size when smaller), or at its own size when asked.
function TiffPage({
	item,
	alt,
	reader,
	pageSourceRef
}: {
	item: DriveItem
	alt: string
	reader: MupdfReader
	pageSourceRef: MupdfImageProps["pageSourceRef"]
}) {
	const { t } = useTranslation("preview")
	const longSide = displayLongSide(useDeviceProfile())
	// A full-resolution draw that failed keeps the reduced one, and is not offered again.
	const [wanted, setWanted] = useState<{ full: boolean; failed: boolean }>({ full: false, failed: false })
	const { full } = wanted
	const [drawn, setDrawn] = useState<Drawn>({ status: "pending" })

	useEffect(() => {
		if (pageSourceRef === undefined) {
			return
		}

		pageSourceRef.current = readerPageSource(reader, 0)

		return () => {
			pageSourceRef.current = null
		}
	}, [reader, pageSourceRef])

	useEffect(() => {
		const controller = new AbortController()

		reader
			.imageExtent(0)
			.then(async natural => {
				// At full resolution, never larger than a canvas of this device holds.
				const size =
					natural === null
						? { width: longSide, height: longSide }
						: full
							? (fullResolution(natural.width, natural.height, longSide, canvasPixels()) ?? natural)
							: fitLongSide(natural.width, natural.height, longSide)
				const bitmap = await reader.renderPage(0, {
					maxPixels: size.width * size.height,
					output: "bitmap",
					signal: controller.signal
				})

				if ("rgba" in bitmap) {
					throw new Error("the engine drew RGBA where a bitmap was asked")
				}

				setDrawn({ status: "shown", bitmap, width: bitmap.width, height: bitmap.height, natural })
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) {
					return
				}

				log.warn("preview", "drawing an image page failed", error)

				// The reduced view stays.
				if (full) {
					setWanted({ full: true, failed: true })
					toast.error(t("previewImageFullFailed"))

					return
				}

				setDrawn({ status: "refused", message: refusalOf(error) ?? "previewImageDecodeFailed" })
			})

		return () => {
			controller.abort()
		}
	}, [reader, full, longSide, t])

	if (drawn.status === "pending") {
		return <PreviewLoading />
	}

	if (drawn.status === "refused") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t(drawn.message)}
			/>
		)
	}

	const { natural } = drawn
	const offered = natural === null ? null : fullResolution(natural.width, natural.height, longSide, canvasPixels())

	return (
		<div className="relative size-full">
			<BitmapImage
				bitmap={drawn.bitmap}
				width={drawn.width}
				height={drawn.height}
				alt={alt}
			/>
			{natural !== null && offered !== null && !full && !wanted.failed ? (
				<ReducedChip
					width={natural.width}
					height={natural.height}
					onShowFull={() => {
						setWanted({ full: true, failed: false })
					}}
				/>
			) : null}
		</div>
	)
}

// Several pages: the PDF reader over the engine's document (pages, zoom, turn, page keys, print, properties), with no
// find: an image has no text.
function TiffPages({
	item,
	alt,
	size,
	reader,
	pageSourceRef
}: {
	item: DriveItem
	alt: string
	size: number
	reader: MupdfReader
	pageSourceRef: MupdfImageProps["pageSourceRef"]
}) {
	const [page, setPage] = useState(1)

	useEffect(() => {
		if (pageSourceRef === undefined) {
			return
		}

		pageSourceRef.current = readerPageSource(reader, page - 1)

		return () => {
			pageSourceRef.current = null
		}
	}, [reader, pageSourceRef, page])

	return (
		<PdfReaderShell
			item={item}
			notice={null}
			document={reader.document}
			viewerDocument={reader.document}
			edit={null}
			alt={alt}
			size={size}
			fullyRead={false}
			ranged={false}
			resident={false}
			onReopen={() => undefined}
			signatures={{ kind: "current", verify: null, onViewSignedVersion: () => undefined }}
			// The engine holds the whole file already.
			fullReadGuard={false}
			searchable={false}
			onPageChange={setPage}
		/>
	)
}
