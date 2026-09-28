import { createFileRoute } from "@tanstack/react-router"
import { PlaylistsScreen } from "@/features/audio/screens/playlists"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Flat page, no splat: the selected playlist is a `playlist` search param owned by PlaylistsSidebar
// (features/audio/components/playlistsSidebar.tsx), same shape as contacts.tsx's `section`. Optional,
// unlike `section`: the rail links here bare and the screen then shows the first playlist. Sidebar rows
// always pass it explicitly, which keeps TanStack's active-link matching exact for them (no
// default-eliding middleware, see contacts.tsx); the no-param fallback highlight is the sidebar's own.
interface PlaylistsSearch {
	playlist?: string
}

function validateSearch(search: Record<string, unknown>): PlaylistsSearch {
	const raw = search["playlist"]

	return typeof raw === "string" && raw.length > 0 ? { playlist: raw } : {}
}

export const Route = createFileRoute("/_app/playlists")({
	head: routeHead({ title: () => [i18n.t("common:modulePlaylists")] }),
	validateSearch,
	component: PlaylistsPage
})

function PlaylistsPage() {
	const { playlist } = Route.useSearch()

	return <PlaylistsScreen selectedUuid={playlist} />
}
