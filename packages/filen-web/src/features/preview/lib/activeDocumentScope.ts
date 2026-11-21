import { createContext, useContext } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"
import { usePublishActiveDocument, type ActiveDocumentPublication } from "@/lib/activeDocument"

// The drive file a preview's viewer may publish as the open document (activeDocument.ts), provided by the overlay's
// body. Null where nothing publishes: a chat's linked file ("links", not the user's drive item), the trash, and a public
// link's page (no body provides it).
export const PreviewDocumentContext = createContext<DriveItem | null>(null)

// The signed-in previews the assistant is beside: My Drive (and Photos), Recents, Favorites, Shared with me and Shared
// by me.
const PUBLISHING_VARIANTS: ReadonlySet<DriveVariant> = new Set<DriveVariant>(["drive", "recents", "favorites", "sharedIn", "sharedOut"])

// The item the overlay's body offers its viewer to publish.
export function previewDocumentItem(item: DriveItem, variant: DriveVariant): DriveItem | null {
	return PUBLISHING_VARIANTS.has(variant) ? item : null
}

// Publishes the viewer's document for the file the overlay shows; an archive's entry (bytes from the archive, not a
// drive file) publishes nothing.
export function usePublishPreviewDocument(publication: ActiveDocumentPublication | null): void {
	const item = useContext(PreviewDocumentContext)
	const entry = useProvidedPreviewOrigin()

	usePublishActiveDocument(entry === null ? item : null, publication)
}
