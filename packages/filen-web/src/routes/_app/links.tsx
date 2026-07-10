import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"

// Flat listing, always uuid-less — the worker resolves "links" straight to listLinkedItems().
export const Route = createFileRoute("/_app/links")({ component: LinksPage })

function LinksPage() {
	return (
		<DirectoryListing
			variant="links"
			splat=""
		/>
	)
}
