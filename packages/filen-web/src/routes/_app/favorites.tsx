import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Flat listing, always uuid-less — the worker resolves "favorites" straight to listFavorites().
export const Route = createFileRoute("/_app/favorites")({
	head: routeHead({ title: () => [i18n.t("drive:driveFavorites")] }),
	component: FavoritesPage
})

function FavoritesPage() {
	return (
		<DirectoryListing
			variant="favorites"
			splat=""
		/>
	)
}
