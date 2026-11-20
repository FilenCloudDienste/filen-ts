import { createFileRoute, useParams } from "@tanstack/react-router"
import { readLastOpened } from "@/features/shell/lib/lastOpened"
import { PlaylistsScreen } from "@/features/audio/screens/playlists"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Playlists layout: playlists.index (/playlists) and playlists.$uuid (/playlists/$uuid) only select, this renders
// the screen for both, so switching playlists never remounts it. Bare /playlists shows the last opened playlist,
// else the first (usePlaylistSelection); the loader warms the stored value so that choice needs no extra render.
// Sidebar rows link the uuid form, which keeps TanStack's active-link matching exact for them; the bare form's
// highlight is the sidebar's own.
export const Route = createFileRoute("/_app/playlists")({
	head: routeHead({ title: () => [i18n.t("common:modulePlaylists")] }),
	loader: async () => {
		await readLastOpened("playlists")
	},
	component: PlaylistsPage
})

function PlaylistsPage() {
	const playlist = useParams({ from: "/_app/playlists/$uuid", shouldThrow: false, select: params => params.uuid })

	return <PlaylistsScreen selectedUuid={playlist} />
}
