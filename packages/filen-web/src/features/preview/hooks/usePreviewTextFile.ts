import { useEffect, useState } from "react"
import { looksLikeText } from "@filen/shared/textEncoding"
import type { DriveItem } from "@/features/drive/lib/item"
import { usePreviewBytes, type UsePreviewBytesResult } from "@/features/preview/hooks/usePreviewBytes"
import { readTextFile, type TextFile } from "@/features/preview/lib/textFile"

export type PreviewTextFile =
	| Exclude<UsePreviewBytesResult, { status: "success" }>
	// The bytes do not look like text: nothing is decoded until the user asks to see them anyway, read-only.
	| { status: "notText"; showAnyway: () => void }
	// `writable`: a save writes back the bytes the file came from.
	| { status: "success"; file: TextFile; writable: boolean }

// The whole-buffer load every text-family viewer opens on. Bytes that do not look like text (looksLikeText) are not
// decoded; once shown anyway they stay read-only. A file asked to be editable that a save would change (not strict
// UTF-8, or not text) tells the overlay through `onReadOnly`, which locks the slot.
export function usePreviewTextFile(item: DriveItem, editable: boolean, onReadOnly: (() => void) | undefined): PreviewTextFile {
	const result = usePreviewBytes(item)
	// The viewer is remounted per file, so this never carries over to another.
	const [shownAnyway, setShownAnyway] = useState(false)
	const notText = result.status === "success" && !looksLikeText(result.bytes)
	const file = result.status === "success" && (!notText || shownAnyway) ? readTextFile(result.bytes) : null
	const writable = file !== null && !notText && file.editableAsIs
	const readOnly = editable && file !== null && !writable

	useEffect(() => {
		if (readOnly) {
			onReadOnly?.()
		}
	}, [readOnly, onReadOnly])

	if (result.status !== "success") {
		return result
	}

	if (file === null) {
		return {
			status: "notText",
			showAnyway: () => {
				setShownAnyway(true)
			}
		}
	}

	return { status: "success", file, writable }
}
