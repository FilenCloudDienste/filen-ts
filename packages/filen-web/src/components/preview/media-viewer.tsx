import { useEffect, useState } from "react"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { allowedMediaContentType } from "@/lib/preview/media-type"
import { isMediaStreamAvailable } from "@/lib/preview/preview-stream"
import { usePreviewBytes } from "@/components/preview/use-preview-bytes"
import { usePreviewStreamUrl } from "@/components/preview/use-preview-stream-url"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"

export interface MediaViewerProps {
	item: DriveItem
	category: "video" | "audio"
	alt: string
}

// The actual <video>/<audio> element, rendered once a src URL is known (either mode below) — Media
// Session metadata is deliberately out of scope here (a later, separate concern). `preload="metadata"`
// avoids eagerly streaming the whole file just to show a scrubber; the SW route/blob URL both support
// seeking past that point either way (the SW via Range/206, a blob URL via the browser's own in-memory
// random access).
function MediaElement({ category, url, alt }: { category: "video" | "audio"; url: string; alt: string }) {
	if (category === "video") {
		return (
			<div className="flex size-full items-center justify-center overflow-hidden p-4">
				<video
					controls
					preload="metadata"
					src={url}
					aria-label={alt}
					className="max-h-full max-w-full"
				/>
			</div>
		)
	}

	return (
		<div className="flex size-full items-center justify-center px-6">
			<audio
				controls
				preload="metadata"
				src={url}
				aria-label={alt}
				className="w-full max-w-md"
			/>
		</div>
	)
}

// Streamed mode: registers against the SW's inline route and renders once a URL resolves. A
// registration failure hands control back to the parent (onFallback) rather than showing an error —
// the buffered path below is the recovery, not a dead end.
function StreamedMedia({
	item,
	category,
	alt,
	contentType,
	onFallback
}: {
	item: DriveItem
	category: "video" | "audio"
	alt: string
	contentType: string
	onFallback: () => void
}) {
	const name = item.data.decryptedMeta?.name ?? item.data.uuid
	const result = usePreviewStreamUrl(item, name, contentType)

	useEffect(() => {
		if (result.status === "error") {
			onFallback()
		}
	}, [result.status, onFallback])

	if (result.status !== "success") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	return (
		<MediaElement
			category={category}
			url={result.url}
			alt={alt}
		/>
	)
}

function BufferedMediaBytes({
	category,
	bytes,
	mime,
	alt
}: {
	category: "video" | "audio"
	bytes: Uint8Array
	mime: string | undefined
	alt: string
}) {
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		// Mirrors image-viewer.tsx's own blob-mint effect — see its comment for the ArrayBuffer-narrowing
		// and double-invoke-safety rationale, identical here.
		const objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime ?? "application/octet-stream" }))

		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate, see image-viewer.tsx's own identical effect
		setUrl(objectUrl)

		return () => {
			URL.revokeObjectURL(objectUrl)
		}
	}, [bytes, mime])

	if (!url) {
		return null
	}

	return (
		<MediaElement
			category={category}
			url={url}
			alt={alt}
		/>
	)
}

// Buffered mode: a whole-buffer download played back from a blob URL. Unlike the streamed path this
// is NEVER size-capped for video/audio (STREAMED_CATEGORIES, preview.logic.ts) — an accepted tradeoff
// of the dev/SW-absent fallback, same as image-viewer.tsx's own buffered path.
function BufferedMedia({ item, category, alt }: { item: DriveItem; category: "video" | "audio"; alt: string }) {
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
		<BufferedMediaBytes
			category={category}
			bytes={result.bytes}
			mime={mime}
			alt={alt}
		/>
	)
}

// Picks the SW's inline-preview route (streamed, seekable, uncapped) when a service worker is
// controlling the tab AND this item's mime passes the inline allowlist, else falls back to the
// buffered whole-file blob path (dev / SW absent / a failed stream registration) — mirrors
// image-viewer.tsx's own ImageViewer picker exactly; see preview-stream.ts's isMediaStreamAvailable
// for the single capability flip point.
export function MediaViewer({ item, category, alt }: MediaViewerProps) {
	const contentType = allowedMediaContentType(item)
	const streamable = contentType !== null && isMediaStreamAvailable()
	const [useBuffered, setUseBuffered] = useState(!streamable)

	if (!useBuffered && contentType !== null) {
		return (
			<StreamedMedia
				item={item}
				category={category}
				alt={alt}
				contentType={contentType}
				onFallback={() => {
					setUseBuffered(true)
				}}
			/>
		)
	}

	return (
		<BufferedMedia
			item={item}
			category={category}
			alt={alt}
		/>
	)
}
