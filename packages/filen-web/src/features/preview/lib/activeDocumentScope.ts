import { createContext, useContext } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"
import { usePublishActiveDocument, type ActiveDocumentPublication } from "@/lib/activeDocument"

// The drive file a preview's viewer may publish as the open document (activeDocument.ts), provided by the overlay's
// body. Null where nothing publishes: outside the drive variant (a chat's linked file is not the user's drive item),
// on a public link's page (no body provides it).
export const PreviewDocumentContext = createContext<DriveItem | null>(null)

// The item the overlay's body offers its viewer to publish.
export function previewDocumentItem(item: DriveItem, variant: DriveVariant): DriveItem | null {
	return variant === "drive" ? item : null
}

// Publishes the viewer's document for the file the overlay shows; an archive's entry (bytes from the archive, not a
// drive file) publishes nothing.
export function usePublishPreviewDocument(publication: ActiveDocumentPublication | null): void {
	const item = useContext(PreviewDocumentContext)
	const entry = useProvidedPreviewOrigin()

	usePublishActiveDocument(entry === null ? item : null, publication)
}
