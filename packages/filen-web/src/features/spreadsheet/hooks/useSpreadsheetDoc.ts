import { useEffect, useState } from "react"
import * as Comlink from "comlink"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { spreadsheetWorker } from "@/features/spreadsheet/lib/spreadsheetClient"
import type { SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import type { SpreadsheetFileKind } from "@/features/spreadsheet/workers/spreadsheet.worker"
import { type ErrorDTO } from "@/lib/sdk/errors"

export type SpreadsheetDocState =
	| { status: "pending" }
	| { status: "error"; dto: ErrorDTO; retry: () => void }
	| { status: "unreadable" }
	| { status: "ready"; id: number; doc: SpreadsheetDoc }

// Downloads the file (the preview's shared byte load and cache) and opens it in the spreadsheet worker,
// closing it there again when the viewer goes. The worker gets a copy: the preview cache keeps the bytes.
export function useSpreadsheetDoc(item: DriveItem, kind: SpreadsheetFileKind): SpreadsheetDocState {
	const bytes = usePreviewBytes(item)
	const [opened, setOpened] = useState<{
		bytes: Uint8Array
		state: { status: "unreadable" } | { status: "ready"; id: number; doc: SpreadsheetDoc }
	} | null>(null)
	const source = bytes.status === "success" ? bytes.bytes : null

	useEffect(() => {
		if (source === null) {
			return undefined
		}

		let live = true
		let id: number | null = null
		const copy = source.slice()

		spreadsheetWorker()
			.open(Comlink.transfer(copy, [copy.buffer]), kind)
			.then(result => {
				if (!live) {
					void spreadsheetWorker().close(result.id)

					return
				}

				id = result.id
				setOpened({ bytes: source, state: { status: "ready", id: result.id, doc: result.doc } })
			})
			.catch(() => {
				if (live) {
					setOpened({ bytes: source, state: { status: "unreadable" } })
				}
			})

		return () => {
			live = false

			if (id !== null) {
				void spreadsheetWorker().close(id)
			}
		}
	}, [source, kind])

	if (bytes.status === "error") {
		return { status: "error", dto: bytes.dto, retry: bytes.refetch }
	}

	// A state from an earlier buffer is not this one's.
	return opened !== null && opened.bytes === source ? opened.state : { status: "pending" }
}
