import { createContext, useContext } from "react"
import { isLinkedEmbedItem, type DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"
import { usePublishActiveDocument, type ActiveDocumentPublication } from "@/lib/activeDocument"

// The drive file a preview's viewer may publish as the open document (activeDocument.ts), provided by the overlay's
// body. Null where nothing publishes (assistantSeesPreview), and on a public link's page (no body provides it).
export const PreviewDocumentContext = createContext<DriveItem | null>(null)

// Whether the assistant is beside a preview and reads its document: every signed-in preview of the user's drive items
// (My Drive and Photos, Recents, Favorites, the user's own links, Shared with me, Shared by me), never the trash, which
// stays hands-off, nor a chat's or a note's linked file, which is not a drive item of the user's (isLinkedEmbedItem;
// it also uses the "links" variant).
export function assistantSeesPreview(item: DriveItem, variant: DriveVariant): boolean {
	return variant !== "trash" && !isLinkedEmbedItem(item)
}

// The item the overlay's body offers its viewer to publish.
export function previewDocumentItem(item: DriveItem, variant: DriveVariant): DriveItem | null {
	return assistantSeesPreview(item, variant) ? item : null
}

// Publishes the viewer's document for the file the overlay shows; an archive's entry (bytes from the archive, not a
// drive file) publishes nothing. Returns what an editor drawing its own selection calls on a selection change.
export function usePublishPreviewDocument(publication: ActiveDocumentPublication | null): () => void {
	const item = useContext(PreviewDocumentContext)
	const entry = useProvidedPreviewOrigin()

	return usePublishActiveDocument(entry === null ? item : null, publication)
}
