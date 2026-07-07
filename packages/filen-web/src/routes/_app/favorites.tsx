import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/components/drive/directory-listing"

// Flat listing, always uuid-less — the worker resolves "favorites" straight to listFavorites().
export const Route = createFileRoute("/_app/favorites")({ component: FavoritesPage })

function FavoritesPage() {
	return (
		<DirectoryListing
			variant="favorites"
			uuid={null}
		/>
	)
}
