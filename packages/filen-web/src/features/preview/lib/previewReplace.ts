import { createContext, use } from "react"
import type { DriveItem } from "@/features/drive/lib/item"

// Makes a file and opens it in the preview in place of the one on screen, whose unsaved edits it does not carry
// (File ▸ New presentation): the overlay asks about them first, as before close, previous and next, and runs `make`
// only once they may go; `make` opens what it made with `open`. Undefined outside an overlay.
export type PreviewReplaceMake = (open: (item: DriveItem) => void) => void

export const PreviewReplaceContext = createContext<((make: PreviewReplaceMake) => void) | undefined>(undefined)

export function usePreviewReplace(): ((make: PreviewReplaceMake) => void) | undefined {
	return use(PreviewReplaceContext)
}
