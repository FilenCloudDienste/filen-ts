import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ListMusicIcon, PlusIcon } from "lucide-react"
import { usePlaylistsQuery } from "@/features/audio/queries/playlists"
import { resolveSelectedPlaylist } from "@/features/audio/lib/playlistSelection"
import { usePlaylistSelection } from "@/features/audio/hooks/usePlaylistSelection"
import { rememberLastOpened } from "@/features/shell/lib/lastOpened"
import { openPlaylistDialog } from "@/features/audio/store/usePlaylistDialogStore"
import { PlaylistPane } from "@/features/audio/components/playlistPane"
import { PlaylistDialogsHost } from "@/features/audio/components/playlistDialogsHost"
import { playlistForKeyTarget } from "@/features/audio/lib/playlistKeys.logic"
import { startPlaylist, startShuffledPlaylist } from "@/features/audio/lib/playlistPlayback"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty"

// The main pane of the /playlists split view; the list is the shell's PlaylistsSidebar. `selectedUuid`
// is the route's raw `playlist` param, resolved here exactly as the sidebar resolves its highlight
// (usePlaylistSelection, then resolveSelectedPlaylist) — both read the one playlists query, so neither
// costs a request. The playlist shown becomes the one a bare /playlists reopens.
export function PlaylistsScreen({ selectedUuid }: { selectedUuid: string | undefined }) {
	const { t } = useTranslation("audio")
	const isOnline = useIsOnline()
	const playlistsQuery = usePlaylistsQuery()
	const selection = usePlaylistSelection(selectedUuid)
	const playlist = resolveSelectedPlaylist(playlistsQuery.data ?? [], selection.uuid)
	const shownUuid = selection.deciding ? undefined : playlist?.uuid
	const entries = playlistsQuery.data ?? []
	const shown = selection.deciding ? null : playlist

	// Defs in features/audio/lib/playlistKeymap.ts. The page's commands stand down under any dialog or menu, and take the
	// buttons' and the ⋯ menu's gates: a write needs a connection, playing needs a track.
	useAction(
		"playlists.newPlaylist",
		() => {
			if (isOnline) {
				openPlaylistDialog({ kind: "create" })
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline]
	)

	useAction(
		"playlists.rename",
		event => {
			const target = playlistForKeyTarget(entries, shown, event.target)

			if (isOnline && target !== null) {
				event.preventDefault()
				openPlaylistDialog({ kind: "rename", playlist: target })
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline, entries, shown]
	)

	useAction(
		"playlists.delete",
		event => {
			const target = playlistForKeyTarget(entries, shown, event.target)

			if (isOnline && target !== null) {
				event.preventDefault()
				openPlaylistDialog({ kind: "delete", playlist: target })
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline, entries, shown]
	)

	useAction(
		"playlists.play",
		event => {
			const target = playlistForKeyTarget(entries, shown, event.target)

			if (target !== null && target.files.length > 0) {
				startPlaylist(target, 0)
			}
		},
		OUTSIDE_OVERLAYS,
		[entries, shown]
	)

	useAction(
		"playlists.shuffle",
		event => {
			const target = playlistForKeyTarget(entries, shown, event.target)

			if (target !== null && target.files.length > 0) {
				startShuffledPlaylist(target)
			}
		},
		OUTSIDE_OVERLAYS,
		[entries, shown]
	)

	useEffect(() => {
		if (shownUuid !== undefined) {
			rememberLastOpened("playlists", shownUuid)
		}
	}, [shownUuid])

	return (
		<>
			{playlistsQuery.status === "pending" || selection.deciding ? (
				<LoadingState size="lg" />
			) : playlistsQuery.status === "error" ? (
				<p className="px-4 py-10 text-center text-sm text-destructive">{errorLabel(playlistsQuery.error)}</p>
			) : playlist !== null ? (
				<PlaylistPane
					// A different playlist is a different page: drag/remove state never carries across.
					key={playlist.uuid}
					playlist={playlist}
				/>
			) : (
				// None exist, or every one is degraded (those still list, muted, in the sidebar).
				<Empty className="flex-1 border-none p-10 app-region-chrome">
					<EmptyHeader>
						<EmptyMedia>
							<ListMusicIcon />
						</EmptyMedia>
						<EmptyTitle>{t("playlistsEmptyTitle")}</EmptyTitle>
						<EmptyDescription>{t("playlistsEmptyBody")}</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button
							disabled={!isOnline}
							onClick={() => {
								openPlaylistDialog({ kind: "create" })
							}}
						>
							<PlusIcon />
							{t("playlistsEmptyAction")}
						</Button>
					</EmptyContent>
				</Empty>
			)}
			<PlaylistDialogsHost selectedUuid={selectedUuid} />
		</>
	)
}
