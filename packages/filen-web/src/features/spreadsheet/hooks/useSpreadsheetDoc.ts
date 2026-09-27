import { useEffect, useState } from "react"
import * as Comlink from "comlink"
import { driveItemName } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { gridDoc, type GridDoc } from "@/features/spreadsheet/lib/cellStore.logic"
import { sniffSpreadsheetKind, spreadsheetFileKind, spreadsheetWorker } from "@/features/spreadsheet/lib/spreadsheetClient"
import { type ErrorDTO } from "@/lib/sdk/errors"

export type SpreadsheetDocState =
	| { status: "pending" }
	| { status: "error"; dto: ErrorDTO; retry: () => void }
	| { status: "unreadable" }
	// `unnamed`: the file's name does not say it is a spreadsheet, so its kind was read from its bytes and
	// it opens read-only (saving could rewrite it as the wrong format).
	| { status: "ready"; id: number; doc: GridDoc; unnamed: boolean }

type Opened = { status: "unreadable" } | { status: "ready"; id: number; doc: GridDoc; unnamed: boolean }

// Downloads the file (the preview's shared byte load and cache) and opens it in the spreadsheet worker,
// closing it there again when the viewer goes. The worker gets a copy: the preview cache keeps the bytes.
// Opens once per `documentKey`: an item that changes under the same key (an own save rotating its uuid)
// keeps the open document, with its undo history.
export function useSpreadsheetDoc(item: DriveItem, documentKey: string): SpreadsheetDocState {
	const [pinned, setPinned] = useState({ key: documentKey, item })

	if (pinned.key !== documentKey) {
		setPinned({ key: documentKey, item })
	}

	const opening = pinned.key === documentKey ? pinned.item : item
	const bytes = usePreviewBytes(opening)
	const base = asDirectoryOrFile(opening)
	const named = spreadsheetFileKind(extensionOf(base.type === "file" ? driveItemName(base) : ""))
	const [opened, setOpened] = useState<{ bytes: Uint8Array; state: Opened } | null>(null)
	const source = bytes.status === "success" ? bytes.bytes : null

	useEffect(() => {
		if (source === null) {
			return undefined
		}

		let live = true
		let id: number | null = null
		const kind = named ?? sniffSpreadsheetKind(source)
		const copy = source.slice()

		spreadsheetWorker()
			.open(Comlink.transfer(copy, [copy.buffer]), kind)
			.then(result => {
				if (!live) {
					void spreadsheetWorker().close(result.id)

					return
				}

				id = result.id
				setOpened({ bytes: source, state: { status: "ready", id: result.id, doc: gridDoc(result.doc), unnamed: named === null } })
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
	}, [source, named])

	if (bytes.status === "error") {
		return { status: "error", dto: bytes.dto, retry: bytes.refetch }
	}

	// A state from an earlier buffer is not this one's.
	return opened !== null && opened.bytes === source ? opened.state : { status: "pending" }
}
