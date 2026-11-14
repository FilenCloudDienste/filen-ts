import { useEffect, useEffectEvent, useState } from "react"
import * as Comlink from "comlink"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { PdfSource } from "@filen/office/dom/pdf"
import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import { MAX_RUN_BLOCKS } from "@/lib/media/blockCache"
import { rangePortReader } from "@/lib/media/rangePort"
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

// One file's bytes on demand for the preview overlay: a range port to the SDK worker (the authed or the anonymous
// one, by access mode), under a token the preview's cancel registry ends on unmount. The bytes come back
// transferred, never copied; nothing is kept here (the reader, pdf.js, keeps what it read). A port the SDK worker
// lost turns into the error state, whose refetch opens a new one. Keyed on the file's content (uuid and size), like
// usePreviewFetch, so a rename keeps the port.
export function usePreviewRangeSource(item: DriveItem, options?: PreviewRangeSourceOptions): UsePreviewRangeSourceResult {
	const anon = usePreviewAccessMode() === "anon"
	const uuid = item.data.uuid
	const size = Number(item.data.size)
	const limit = options?.limit
	const length = limit === undefined ? size : Math.max(0, Math.min(limit, size))
	const [attempt, setAttempt] = useState(0)
	const [entry, setEntry] = useState<{
		readonly key: string
		readonly result: Exclude<UsePreviewRangeSourceResult, { status: "pending" }>
	} | null>(null)
	const key = `${uuid}:${String(length)}:${String(anon)}:${String(attempt)}`
	const latestItem = useEffectEvent(() => item)

	useEffect(() => {
		const file = narrowToAnyFile(latestItem())
		const token = crypto.randomUUID()
		const reads = new AbortController()
		let live = true
		let reader: ReturnType<typeof rangePortReader> | null = null
		const refetch = (): void => {
			setAttempt(value => value + 1)
		}
		const fail = (error: unknown): void => {
			if (live) setEntry({ key, result: { status: "error", dto: asErrorDTO(error), refetch } })
		}
		const { port1, port2 } = new MessageChannel()
		const transferred = Comlink.transfer(port1, [port1])

		void (anon ? sdkApi.openLinkedRangePortAnon(transferred, file, token) : sdkApi.openRangePort(transferred, file, token)).then(
			() => {
				if (!live) {
					port2.close()

					return
				}

				const opened = rangePortReader(port2)

				reader = opened
				opened.onLost(() => {
					fail(new Error("range port lost"))
				})

				const source: PdfRangeSource = {
					kind: "ranges",
					length,
					read: (offset, count) => opened.readRange(offset, offset + count, reads.signal),
					chunkSize: PREVIEW_RANGE_CHUNK,
					maxRead: PREVIEW_RANGE_MAX_READ
				}

				setEntry({ key, result: { status: "success", source, refetch } })
			},
			(error: unknown) => {
				port2.close()
				fail(error)
			}
		)

		return () => {
			live = false
			reads.abort()
			reader?.close()
			// Ends every read still served on the port, and the port itself.
			void sdkApi.cancelPreviewDownload(token)
		}
	}, [key, anon, length])

	return entry !== null && entry.key === key ? entry.result : { status: "pending" }
}
