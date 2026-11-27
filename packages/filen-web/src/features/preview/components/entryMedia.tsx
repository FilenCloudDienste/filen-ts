import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { probeSource, probeVideo, type MediaCodec, type VideoProbe } from "@filen/shared/videos"
import { sdkApi } from "@/lib/sdk/client"
import { originRanged, originSize, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { useObjectUrl } from "@/lib/useObjectUrl"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import type { DriveItem } from "@/features/drive/lib/item"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { mediaControlsList, usePreviewAccessMode, usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { usePreviewFetch } from "@/features/preview/hooks/usePreviewFetch"
import { usePreviewMediaSession } from "@/features/preview/hooks/usePreviewMediaSession"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { unplayableCodecs } from "@/features/preview/lib/previewPlayback.logic"
import { MediaCannotStream, MediaFormatFailure } from "@/features/preview/components/mediaFailureState"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { NON_SEEKABLE_MEDIA_MAX_BYTES } from "@/features/archive/lib/entryAccess.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"

// An archive entry's video or audio (W6 §3.10), or an attachment's. A `mapped` or `seekable` entry streams through the
// service worker from the SDK worker's range port (registerPortStream over openOriginRangePort): no JS buffer holds it,
// and a seekable one says under the player that a seek may pause while it decodes (§6.2 A). One read only whole is
// played from a Blob (the entry viewer caps it at 64 MiB first), and so is a streamable one of that size where the
// service worker cannot serve it. The browser plays it natively; one it cannot names its codecs from a probe: of the
// Blob on the page when it is held, else of the stream's head through readOriginProbe.
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

// Names what an unplayable entry holds; `signal` aborts once its element is gone.
type Probe = (signal: AbortSignal) => Promise<VideoProbe | null>

function StreamedEntryMedia({ item, category, alt, origin, contentType }: EntryMediaSourceProps) {
	const { t } = useTranslation("preview")
	const access = usePreviewAccessMode()
	const result = usePreviewStreamUrl(item, driveItemName(item), contentType)

	if (result.status === "pending") {
		return <PreviewLoading />
	}

	// Its port could not be registered (no service worker serves the page): one small enough plays from a buffer.
	if (result.status === "error") {
		return originSize(origin) <= NON_SEEKABLE_MEDIA_MAX_BYTES ? (
			<BufferedEntryMedia
				item={item}
				category={category}
				alt={alt}
				origin={origin}
				contentType={contentType}
			/>
		) : (
			<MediaCannotStream item={item} />
		)
	}

	// The head tier: the browser already read the stream's head, and a seekable entry's tail decodes most of it.
	const probe: Probe = signal => {
		const token = crypto.randomUUID()

		signal.addEventListener(
			"abort",
			() => {
				void sdkApi.cancelPreviewDownload(token)
			},
			{ once: true }
		)

		return sdkApi.readOriginProbe(origin, access, "card", token)
	}

	return (
		<EntryMediaElement
			item={item}
			category={category}
			alt={alt}
			probe={probe}
			src={result.url}
			note={origin.kind === "entry" && origin.access === "seekable" ? t("previewArchiveMediaSeekNote") : null}
		/>
	)
}

// The entry as one Blob: an attachment's is the Blob its holder has; an entry's is read once (checked), wrapped in the
// same tick and its array dropped, so the page holds it once. Not kept in the preview cache, which would hold the array
// beside the Blob.
function BufferedEntryMedia({ item, category, alt, origin, contentType }: EntryMediaSourceProps) {
	const access = usePreviewAccessMode()
	// A slice shares the held Blob's bytes, typed for the element.
	const held = (): Blob | undefined => (origin.kind === "bytes" ? origin.blob.slice(0, origin.blob.size, contentType) : undefined)
	const result = usePreviewFetch<Blob>(item, {
		seed: held,
		run: async ({ token, signal, cacheScope }) =>
			held() ??
			new Blob(
				[
					(await loadOriginBytes(origin, token, {
						access,
						cap: originSize(origin),
						scope: cacheScope,
						signal,
						store: false
					})) as Uint8Array<ArrayBuffer>
				],
				{ type: contentType }
			)
	})

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
			blob={result.value}
			contentType={contentType}
		/>
	)
}

function HeldEntryMedia({
	blob,
	contentType,
	...props
}: Omit<EntryMediaSourceProps, "contentType" | "origin"> & { blob: Blob; contentType: string }) {
	const url = useObjectUrl(blob, contentType)
	// Probed on the page from the Blob it plays: nothing read again.
	const probe: Probe = signal => {
		const source = probeSource(
			blob.size,
			async (start, end) => {
				signal.throwIfAborted()

				return new Uint8Array(await blob.slice(start, end).arrayBuffer())
			},
			"full"
		)

		return probeVideo(source, "full")
	}

	return url === null ? (
		<PreviewLoading />
	) : (
		<EntryMediaElement
			{...props}
			probe={probe}
			src={url}
			note={null}
		/>
	)
}

function EntryMediaElement({
	item,
	category,
	alt,
	probe,
	src,
	note
}: {
	item: DriveItem
	category: "video" | "audio"
	alt: string
	probe: Probe
	src: string
	note: string | null
}) {
	const downloadable = usePreviewDownloadable()
	const [failed, setFailed] = useState<readonly MediaCodec[] | null>(null)
	const probing = useRef<AbortController | null>(null)
	const [media, setMedia] = useState<HTMLMediaElement | null>(null)

	usePreviewMediaSession(media, alt)

	// A probe still reading once the element is gone is cancelled.
	useEffect(
		() => () => {
			probing.current?.abort()
		},
		[]
	)

	if (failed !== null) {
		return (
			<MediaFormatFailure
				item={item}
				codecs={failed}
			/>
		)
	}

	// The browser cannot play it: the probe names what it holds, once.
	const fail = (): void => {
		if (probing.current !== null) {
			return
		}

		const controller = new AbortController()

		probing.current = controller
		void probe(controller.signal).then(
			found => {
				if (!controller.signal.aborted) {
					setFailed(unplayableCodecs(found, null))
				}
			},
			() => {
				if (!controller.signal.aborted) {
					setFailed([])
				}
			}
		)
	}

	return (
		<div className="flex size-full flex-col items-center justify-center gap-2 p-4">
			{category === "video" ? (
				<video
					ref={setMedia}
					controls
					controlsList={mediaControlsList(downloadable)}
					src={src}
					aria-label={alt}
					className="max-h-full min-h-0 max-w-full"
					onError={fail}
				/>
			) : (
				<audio
					ref={setMedia}
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
