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
import { fitLongSide, fullResolution } from "@/features/preview/lib/rasterCodecs/display"
import { readerPageSource, type ImagePageSlot, type ImagePageSource } from "@/features/preview/lib/imagePageSource"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { BitmapImage } from "@/features/preview/components/zoomableImage"
import { HeldImageGate, ReducedChip } from "@/features/preview/components/decodedImage"
import { PdfReaderShell } from "@/features/preview/components/pdfReaderShell"
import { usePreviewAccessMode, usePreviewCacheScope, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { log } from "@/lib/log"

// A TIFF, read by the MuPDF read role in an engine of its own (sign-out and unmount end it): one page drawn whole as a
// bitmap at the display long side, its full resolution a click away; several pages in the PDF viewer's page column
// (tiles, zoom, page keys), with no find (an image has no text). Its header is read first: a BigTIFF, which the engine
// does not read, and a first page larger than the engine's pixel budget are refused before any engine starts.

// The head every TIFF header and, usually, the first IFD sit in.
const TIFF_HEAD_BYTES = 64 * 1024

type Opened =
	| { readonly status: "refused"; readonly message: PreviewKey }
	| { readonly status: "failed" }
	| { readonly status: "open"; readonly reader: MupdfReader }

export interface TiffImageProps {
	item: DriveItem
	alt: string
	// Holds the page shown while it is mounted, for the image editor to draw from the engine that holds the file.
	pageSourceRef?: RefObject<ImagePageSlot | null> | undefined
}

export function TiffImage(props: TiffImageProps) {
	return (
		<HeldImageGate
			item={props.item}
			tooLarge="previewTooLargeToShowHere"
		>
			<TiffDocument {...props} />
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
		case "notSupported":
			return "previewImageNotDisplayable"
		default:
			return null
	}
}

async function openTiff(
	origin: ByteOrigin,
	access: OriginAccess,
	scope: string | null,
	profile: DeviceProfile,
	signal: AbortSignal
): Promise<Opened> {
	const head = await openByteReader(origin, crypto.randomUUID(), { access, blocks: 1 }).then(async reader => {
		try {
			return await reader.read(0, TIFF_HEAD_BYTES, signal)
		} finally {
			reader.close()
		}
	})
	const header = sniffTiff(head, originSize(origin))

	if (header === null) {
		return { status: "refused", message: "previewImageNotDisplayable" }
	}

	if (header.kind === "bigTiff") {
		return { status: "refused", message: "previewBigTiffUnsupported" }
	}

	const maxImagePixels = mupdfImagePixels(profile, origin, "tiff")

	// A first page past the head is checked by the engine from its header, before it is drawn.
	if (header.size !== null && header.size.width * header.size.height > maxImagePixels) {
		return { status: "refused", message: "previewImageTooLarge" }
	}

	return { status: "open", reader: await openMupdfReader({ origin, access, scope, format: "tiff", maxImagePixels, signal }) }
}

function TiffDocument({ item, alt, pageSourceRef }: TiffImageProps) {
	const { t } = useTranslation("preview")
	const origin = usePreviewOrigin(item)
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

		openTiff(current, access, scope, now, controller.signal).then(
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
					log.warn("preview", "opening a TIFF failed", error)
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
	}, [key, access, scope, pageSourceRef])

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
	pageSourceRef: TiffImageProps["pageSourceRef"]
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

				log.warn("preview", "drawing a TIFF page failed", error)

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
	reader,
	pageSourceRef
}: {
	item: DriveItem
	alt: string
	reader: MupdfReader
	pageSourceRef: TiffImageProps["pageSourceRef"]
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
			size={Number(item.data.size)}
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
