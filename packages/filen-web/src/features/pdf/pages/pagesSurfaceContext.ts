import { createContext, use, useSyncExternalStore } from "react"
import { driveItemName } from "@filen/shared"
import type { PdfEditEngine, PdfEditSnapshot } from "@filen/office/react/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PdfPagesController, PdfPagesView } from "@/features/pdf/pages/pagesController"
import type { PdfPolicyState, PdfToolContext } from "@/features/pdf/tools/registry"

// What the editor's page surfaces (pages rail, Organise grid, page dialogs, crop) share, provided by the viewer: the
// document shown, the editor's engine (thumbnails after the swap) and the page operations (PdfPagesController).

export interface PdfPagesSurfaceValue {
	readonly controller: PdfPagesController
	// The document shown (pdf.js's, or the editor's after the swap).
	readonly document: PdfDomDocument
	readonly engine: PdfEditEngine | null
	readonly snapshot: PdfEditSnapshot | null
	readonly item: DriveItem
	readonly policy: PdfPolicyState
	readonly toolContext: PdfToolContext
	// The view's rotation, added to every page's own (0, 90, 180, 270).
	readonly viewRotation: number
	readonly online: boolean
}

export const PdfPagesSurfaceContext = createContext<PdfPagesSurfaceValue | null>(null)

export function usePdfPagesSurface(): PdfPagesSurfaceValue {
	const surface = use(PdfPagesSurfaceContext)

	if (surface === null) throw new Error("no PDF pages surface")

	return surface
}

export function usePagesView(controller: PdfPagesController): PdfPagesView {
	return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}

export function isPdfItem(item: DriveItem): boolean {
	return item.type === "file" && driveItemName(item).toLowerCase().endsWith(".pdf")
}
