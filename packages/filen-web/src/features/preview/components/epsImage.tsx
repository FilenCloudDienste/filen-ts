import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PreviewKey } from "@/lib/i18n"
import { bytesOrigin, originKey, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { openByteReader } from "@/features/preview/lib/origin/byteReader"
import { epsPreview, type EpsPreview } from "@/features/preview/lib/epsPreview"
import { usePreviewAccessMode, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { DecodedImageBytes } from "@/features/preview/components/decodedImage"
import { MupdfDocument } from "@/features/preview/components/mupdfImage"
import { log } from "@/lib/log"

// An EPS file, shown by the preview picture it carries; its PostScript is never run. A DOS EPS's TIFF section is read
// by range and opened in the MuPDF read role as a TIFF; an EPSI preview's hex is read by range and decoded in the raster
// decode pool. One with neither (a WMF preview, or none) says so.

type Found =
	| { readonly status: "tiff"; readonly origin: ByteOrigin }
	| { readonly status: "epsi"; readonly bytes: Uint8Array }
	| { readonly status: "none"; readonly message: PreviewKey }
	| { readonly status: "failed" }

async function readPreview(origin: ByteOrigin, access: "authed" | "anon", signal: AbortSignal): Promise<Found> {
	const reader = await openByteReader(origin, crypto.randomUUID(), { access, blocks: 1 })

	try {
		const preview: EpsPreview = await epsPreview(reader, signal)

		switch (preview.kind) {
			case "tiff":
				// A Blob of the section, read by the engine whole (its lifetime is this view's).
				return {
					status: "tiff",
					origin: bytesOrigin(
						new Blob([preview.bytes as Uint8Array<ArrayBuffer>], { type: "image/tiff" }),
						`${originKey(origin)}#tiff`
					)
				}
			case "epsi":
				return { status: "epsi", bytes: preview.bytes }
			case "none":
				return { status: "none", message: "previewEpsNoPreview" }
			case "tooLarge":
				return { status: "none", message: "previewImageTooLarge" }
			case "unreadable":
				return { status: "none", message: "previewImageNotDisplayable" }
		}
	} finally {
		reader.close()
	}
}

export function EpsImage({ item, alt }: { item: DriveItem; alt: string }) {
	const { t } = useTranslation("preview")
	const origin = usePreviewOrigin(item)
	const access = usePreviewAccessMode()
	const [attempt, setAttempt] = useState(0)
	const key = `${originKey(origin)}:${String(attempt)}`
	const [found, setFound] = useState<{ key: string; found: Found } | null>(null)
	const latestOrigin = useEffectEvent(() => origin)

	useEffect(() => {
		const controller = new AbortController()

		readPreview(latestOrigin(), access, controller.signal).then(
			result => {
				if (!controller.signal.aborted) {
					setFound({ key, found: result })
				}
			},
			(error: unknown) => {
				if (!controller.signal.aborted) {
					log.warn("preview", "reading an EPS preview failed", error)
					setFound({ key, found: { status: "failed" } })
				}
			}
		)

		return () => {
			controller.abort()
		}
	}, [key, access])

	const current = found?.key === key ? found.found : null

	if (current === null) {
		return <PreviewLoading />
	}

	switch (current.status) {
		case "tiff":
			return (
				<MupdfDocument
					item={item}
					alt={alt}
					format="tiff"
					source={current.origin}
				/>
			)
		case "epsi":
			return (
				<DecodedImageBytes
					item={item}
					bytes={current.bytes}
					alt={alt}
					format="epsi"
				/>
			)
		case "none":
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
	}
}
