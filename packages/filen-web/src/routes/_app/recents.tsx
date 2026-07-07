import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/components/drive/directory-listing"

// Flat listing, always uuid-less — the worker resolves "recents" straight to listRecents().
export const Route = createFileRoute("/_app/recents")({ component: RecentsPage })

function RecentsPage() {
	return (
		<DirectoryListing
			variant="recents"
			uuid={null}
		/>
	)
}
