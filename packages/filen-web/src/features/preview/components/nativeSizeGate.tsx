import { useEffect, useEffectEvent, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/features/drive/lib/item"
import { Button } from "@/components/ui/button"
import { originKey, originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { openByteReader } from "@/features/preview/lib/origin/byteReader"
import { sniffImage } from "@/features/preview/lib/imageSniff/sniffImage"
import { usePreviewAccessMode, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { log } from "@/lib/log"

// A native image on a device with a native view cap (a phone): its size read from its head before the browser is
// handed it, and one past the cap not handed over unless asked. A head that names no size, or a read that fails, shows
// the image as before.

// Where every header the sniff reads sits.
const HEAD_BYTES = 64 * 1024

async function headPixels(origin: ByteOrigin, access: OriginAccess, signal: AbortSignal): Promise<number | null> {
	const reader = await openByteReader(origin, crypto.randomUUID(), { access, blocks: 1 })

	try {
		const info = sniffImage(await reader.read(0, HEAD_BYTES, signal), originSize(origin))

		return info === null ? null : info.width * info.height
	} finally {
		reader.close()
	}
}

export function NativeSizeGate({ item, cap, children }: { item: DriveItem; cap: number; children: ReactNode }) {
	const { t } = useTranslation("preview")
	const origin = usePreviewOrigin(item)
	const access = usePreviewAccessMode()
	const key = originKey(origin)
	const [verdict, setVerdict] = useState<{ key: string; over: boolean } | null>(null)
	const [anyway, setAnyway] = useState<string | null>(null)
	const latestOrigin = useEffectEvent(() => origin)

	useEffect(() => {
		const controller = new AbortController()

		headPixels(latestOrigin(), access, controller.signal).then(
			pixels => {
				if (!controller.signal.aborted) {
					setVerdict({ key, over: pixels !== null && pixels > cap })
				}
			},
			(error: unknown) => {
				if (!controller.signal.aborted) {
					log.warn("preview", "reading an image's size failed", error)
					setVerdict({ key, over: false })
				}
			}
		)

		return () => {
			controller.abort()
		}
	}, [key, access, cap])

	const current = verdict?.key === key ? verdict : null

	if (current === null) {
		return <PreviewLoading />
	}

	if (current.over && anyway !== key) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewImageTooLarge")}
				secondary={
					<Button
						variant="outline"
						onClick={() => {
							setAnyway(key)
						}}
					>
						{t("previewImageOpenAnyway")}
					</Button>
				}
			/>
		)
	}

	return children
}
