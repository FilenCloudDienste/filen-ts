import { useTranslation } from "react-i18next"
import { ListMusicIcon, PlusIcon } from "lucide-react"
import { usePlaylistsQuery } from "@/features/audio/queries/playlists"
import { resolveSelectedPlaylist } from "@/features/audio/lib/playlistSelection"
import { openPlaylistDialog } from "@/features/audio/store/usePlaylistDialogStore"
import { PlaylistPane } from "@/features/audio/components/playlistPane"
import { PlaylistDialogsHost } from "@/features/audio/components/playlistDialogsHost"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty"

// The main pane of the /playlists split view; the list is the shell's PlaylistsSidebar. `selectedUuid`
// is the route's raw `playlist` param, resolved here exactly as the sidebar resolves its highlight
// (resolveSelectedPlaylist) — both read the one playlists query, so neither costs a request.
export function PlaylistsScreen({ selectedUuid }: { selectedUuid: string | undefined }) {
	const { t } = useTranslation("audio")
	const isOnline = useIsOnline()
	const playlistsQuery = usePlaylistsQuery()
	const playlist = resolveSelectedPlaylist(playlistsQuery.data ?? [], selectedUuid)

	return (
		<>
			{playlistsQuery.status === "pending" ? (
				<LoadingState size="lg" />
			) : playlistsQuery.status === "error" ? (
				<p className="px-4 py-10 text-center text-sm text-destructive">{errorLabel(asErrorDTO(playlistsQuery.error))}</p>
			) : playlist !== null ? (
				<PlaylistPane
					// A different playlist is a different page: drag/remove state never carries across.
					key={playlist.uuid}
					playlist={playlist}
				/>
			) : (
				// None exist, or every one is degraded (those still list, muted, in the sidebar).
				<Empty className="flex-1 border-none p-10">
					<EmptyHeader>
						<EmptyMedia variant="icon">
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
