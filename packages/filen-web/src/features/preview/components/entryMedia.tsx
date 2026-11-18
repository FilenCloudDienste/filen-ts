import { useState } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { originRanged, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { useObjectUrl } from "@/lib/useObjectUrl"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import type { DriveItem } from "@/features/drive/lib/item"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { mediaControlsList, usePreviewAccessMode, usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { unplayableCodecs } from "@/features/preview/lib/previewPlayback.logic"
import { MediaFormatFailure } from "@/features/preview/components/mediaFailureState"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import type { MediaCodec } from "@filen/shared/videos"
import { errorLabel } from "@/lib/i18n/errorLabel"

// An archive entry's video or audio (W6 §3.10). A `mapped` or `seekable` entry streams through the service worker from
// the SDK worker's range port (registerPortStream over openOriginRangePort): no JS buffer holds it, and a seekable one
// says under the player that a seek may pause while it decodes (§6.2 A). One read only whole is played from a Blob (the
// entry viewer caps it at 64 MiB first). The browser plays it natively; one it cannot names its codecs, read through
// readOriginProbe.
export function EntryMedia({
	item,
	category,
	alt,
	origin
}: {
	item: DriveItem
	category: "video" | "audio"
	alt: string
	origin: ByteOrigin
}) {
	const profile = useDeviceProfile()
	const contentType = allowedMediaContentType(item, profile)

	if (contentType === null) {
		return (
			<MediaFormatFailure
				item={item}
				codecs={[]}
			/>
		)
	}

	return originRanged(origin) ? (
		<StreamedEntryMedia
			item={item}
			category={category}
			alt={alt}
			origin={origin}
			contentType={contentType}
		/>
	) : (
		<BufferedEntryMedia
			item={item}
			category={category}
			alt={alt}
			origin={origin}
			contentType={contentType}
		/>
	)
}

interface EntryMediaSourceProps {
	item: DriveItem
	category: "video" | "audio"
	alt: string
	origin: ByteOrigin
	contentType: string
}

function StreamedEntryMedia({ item, category, alt, origin, contentType }: EntryMediaSourceProps) {
	const { t } = useTranslation("preview")
	const result = usePreviewStreamUrl(item, driveItemName(item), contentType)

	if (result.status === "pending") {
		return <PreviewLoading />
	}

	// Its port could not be registered: no other way plays it.
	if (result.status === "error") {
		return (
			<MediaFormatFailure
				item={item}
				codecs={[]}
			/>
		)
	}

	return (
		<EntryMediaElement
			item={item}
			category={category}
			alt={alt}
			origin={origin}
			src={result.url}
			note={origin.kind === "entry" && origin.access === "seekable" ? t("previewArchiveMediaSeekNote") : null}
		/>
	)
}

function BufferedEntryMedia({ item, category, alt, origin, contentType }: EntryMediaSourceProps) {
	const result = usePreviewBytes(item)

	if (result.status === "error") {
		return (
			<PreviewErrorState
				message={errorLabel(result.dto)}
				onRetry={result.refetch}
			/>
		)
	}

	if (result.status === "pending") {
		return <PreviewLoading />
	}

	return (
		<HeldEntryMedia
			item={item}
			category={category}
			alt={alt}
			origin={origin}
			bytes={result.bytes}
			contentType={contentType}
		/>
	)
}

function HeldEntryMedia({
	bytes,
	contentType,
	...props
}: Omit<EntryMediaSourceProps, "contentType"> & { bytes: Uint8Array; contentType: string }) {
	const url = useObjectUrl(bytes, contentType)

	return url === null ? (
		<PreviewLoading />
	) : (
		<EntryMediaElement
			{...props}
			src={url}
			note={null}
		/>
	)
}

function EntryMediaElement({
	item,
	category,
	alt,
	origin,
	src,
	note
}: {
	item: DriveItem
	category: "video" | "audio"
	alt: string
	origin: ByteOrigin
	src: string
	note: string | null
}) {
	const downloadable = usePreviewDownloadable()
	const access = usePreviewAccessMode()
	const [failed, setFailed] = useState<readonly MediaCodec[] | null>(null)

	if (failed !== null) {
		return (
			<MediaFormatFailure
				item={item}
				codecs={failed}
			/>
		)
	}

	// The browser cannot play it: the probe names what it holds.
	const fail = (): void => {
		void sdkApi.readOriginProbe(origin, access, "full", crypto.randomUUID()).then(
			probe => {
				setFailed(unplayableCodecs(probe, null))
			},
			() => {
				setFailed([])
			}
		)
	}

	return (
		<div className="flex size-full flex-col items-center justify-center gap-2 p-4">
			{category === "video" ? (
				<video
					controls
					controlsList={mediaControlsList(downloadable)}
					src={src}
					aria-label={alt}
					className="max-h-full min-h-0 max-w-full"
					onError={fail}
				/>
			) : (
				<audio
					controls
					controlsList={mediaControlsList(downloadable)}
					preload="metadata"
					src={src}
					aria-label={alt}
					className="w-full max-w-md"
					onError={fail}
				/>
			)}
			{note === null ? null : <p className="text-center text-xs text-muted-foreground">{note}</p>}
		</div>
	)
}
