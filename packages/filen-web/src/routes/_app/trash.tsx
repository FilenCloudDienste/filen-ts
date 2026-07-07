import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/components/drive/directory-listing"

// Flat listing, always uuid-less — the worker resolves "trash" straight to listTrash().
export const Route = createFileRoute("/_app/trash")({ component: TrashPage })

function TrashPage() {
	return (
		<DirectoryListing
			variant="trash"
			uuid={null}
		/>
	)
}
