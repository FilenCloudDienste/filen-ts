import { useEffect, useEffectEvent, useState } from "react"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { PdfSource } from "@filen/office/dom/pdf"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { openOriginRangeSource, type OriginRangeSource } from "@/features/preview/lib/origin/rangeSource"
import { originKey, originSize } from "@/lib/sdk/byteOrigin"
import { MAX_RUN_BLOCKS } from "@/lib/media/blockCache"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"

export type PdfRangeSource = Extract<PdfSource, { kind: "ranges" }>

export type UsePreviewRangeSourceResult =
	| { status: "pending" }
	| { status: "success"; source: PdfRangeSource; refetch: () => void }
	| { status: "error"; dto: ErrorDTO; refetch: () => void }

export interface PreviewRangeSourceOptions {
	// Reads only this many bytes from the file's start: a byte prefix shown as a file of its own (an earlier revision
	// of a PDF). Unset: the whole file.
	readonly limit?: number
}

// The reads a ranged document makes: whole SDK blocks (each is downloaded and decrypted whole, so aligned reads fetch
// every byte once), and at most a run of blocks per read, as the media readers ask for.
export const PREVIEW_RANGE_CHUNK = BLOCK_BYTES
export const PREVIEW_RANGE_MAX_READ = MAX_RUN_BLOCKS * BLOCK_BYTES

// One file's bytes on demand for the preview overlay: a range source over the viewer's origin (usePreviewOrigin: the
// session's or a public link's client, or a provided origin), under a token the preview's cancel registry ends on
// unmount. The bytes come back transferred, never copied; nothing is kept here (the reader, pdf.js, keeps what it
// read). A port the SDK worker lost turns into the error state, whose refetch opens a new one. Keyed on the origin's
// content (its key and size), like usePreviewFetch, so a rename keeps the port.
export function usePreviewRangeSource(item: DriveItem, options?: PreviewRangeSourceOptions): UsePreviewRangeSourceResult {
	const origin = usePreviewOrigin(item)
	const size = originSize(origin)
	const limit = options?.limit
	const length = limit === undefined ? size : Math.max(0, Math.min(limit, size))
	const [attempt, setAttempt] = useState(0)
	const [entry, setEntry] = useState<{
		readonly key: string
		readonly result: Exclude<UsePreviewRangeSourceResult, { status: "pending" }>
	} | null>(null)
	const key = `${origin.kind}:${originKey(origin)}:${String(length)}:${String(attempt)}`
	const latestOrigin = useEffectEvent(() => origin)

	useEffect(() => {
		const token = crypto.randomUUID()
		const reads = new AbortController()
		let live = true
		let opened: OriginRangeSource | null = null
		const refetch = (): void => {
			setAttempt(value => value + 1)
		}
		const fail = (error: unknown): void => {
			if (live) setEntry({ key, result: { status: "error", dto: asErrorDTO(error), refetch } })
		}

		void openOriginRangeSource(latestOrigin(), token, { limit: length }).then(
			source => {
				if (!live) {
					source.close()

					return
				}

				opened = source
				source.reader.onLost(() => {
					fail(new Error("range port lost"))
				})

				const pdfSource: PdfRangeSource = {
					kind: "ranges",
					length,
					read: (offset, count) => source.reader.readRange(offset, offset + count, reads.signal),
					chunkSize: PREVIEW_RANGE_CHUNK,
					maxRead: PREVIEW_RANGE_MAX_READ
				}

				setEntry({ key, result: { status: "success", source: pdfSource, refetch } })
			},
			(error: unknown) => {
				fail(error)
			}
		)

		return () => {
			live = false
			reads.abort()

			// Ends every read still served on the port, and the port itself; before the source opened, the open.
			if (opened === null) {
				void sdkApi.cancelPreviewDownload(token)
			} else {
				opened.close()
			}
		}
	}, [key, length])

	return entry !== null && entry.key === key ? entry.result : { status: "pending" }
}
