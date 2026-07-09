import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"

// Flat listing, always uuid-less — the worker resolves "favorites" straight to listFavorites().
export const Route = createFileRoute("/_app/favorites")({ component: FavoritesPage })

function FavoritesPage() {
	return (
		<DirectoryListing
			variant="favorites"
			splat=""
		/>
	)
}
