import { useTranslation } from "react-i18next"
import { Link, useSearch } from "@tanstack/react-router"
import { ListMusicIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { cn, type Playlist } from "@filen/shared"
import { usePlaylistsQuery, type PlaylistEntry } from "@/features/audio/queries/playlists"
import { resolveSelectedPlaylist } from "@/features/audio/lib/playlistSelection"
import { usePlaylistSelection } from "@/features/audio/hooks/usePlaylistSelection"
import { openPlaylistDialog } from "@/features/audio/store/usePlaylistDialogStore"
import { PlaylistArtwork } from "@/features/audio/components/playlistArtwork"
import { PlaylistMenuContent } from "@/features/audio/components/playlistMenu"
import { useKnownCoverUrl } from "@/features/audio/hooks/useTrackMetadata"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SidebarPanel } from "@/features/shell/components/sidebarPanel"

// ContactsSidebar's nav-row idiom, grown to two lines for the thumbnail + meta. Keyed on aria-current
// rather than TanStack's data-status: with no (or a stale) `playlist` param the view shows the last
// opened or first playlist, which no Link's own search matches, so the row sets aria-current itself (Link
// only ever adds the same value on an exact match).
const ROW_CLASS = cn(
	"flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-sm focus-ring transition-colors outline-none app-region-no-drag",
	"text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
	"aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground"
)

// The shell's playlists contextual sidebar: same w-52 rounded-xl panel as ContactsSidebar, one row per
// playlist. Rows link to /playlists with an always-explicit `playlist` param (see
// routes/_app/playlists.tsx); create/rename/delete open the shared PlaylistDialogsHost the route
// screen mounts.
export function PlaylistsSidebar() {
	const { t } = useTranslation(["audio", "common"])
	const isOnline = useIsOnline()
	const playlistsQuery = usePlaylistsQuery()
	// Loose: the shell mounts this panel off the pathname, so it reads the param without asserting the
	// match (the same render can still hold the previous route's).
	const selectedParam = useSearch({ strict: false, select: search => search.playlist })
	const selection = usePlaylistSelection(selectedParam)
	const entries = playlistsQuery.data ?? []
	const selectedUuid = selection.deciding ? undefined : resolveSelectedPlaylist(entries, selection.uuid)?.uuid

	return (
		<SidebarPanel>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
				<div className="flex items-center justify-between gap-2 pb-2.5 pl-2.5">
					<h2 className="truncate pt-1 text-[15px] font-semibold">{t("common:modulePlaylists")}</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={!isOnline}
						aria-label={t("newPlaylist")}
						title={!isOnline ? t("common:offlineActionDisabled") : undefined}
						className="app-region-no-drag"
						onClick={() => {
							openPlaylistDialog({ kind: "create" })
						}}
					>
						<PlusIcon />
					</Button>
				</div>
				{playlistsQuery.status === "pending" ? (
					<LoadingState
						size="sm"
						className="py-4"
					/>
				) : playlistsQuery.status === "error" ? (
					<p className="px-2.5 text-xs text-destructive">{errorLabel(playlistsQuery.error)}</p>
				) : (
					<ul className="flex flex-col gap-0.5">
						{entries.map(entry => (
							<PlaylistSidebarRow
								key={entry.status === "ok" ? entry.playlist.uuid : entry.fileUuid}
								entry={entry}
								selected={entry.status === "ok" && entry.playlist.uuid === selectedUuid}
							/>
						))}
					</ul>
				)}
			</div>
		</SidebarPanel>
	)
}

function PlaylistSidebarRow({ entry, selected }: { entry: PlaylistEntry; selected: boolean }) {
	const { t } = useTranslation("audio")

	if (entry.status === "degraded") {
		return (
			<li className="flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-muted-foreground">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
					<ListMusicIcon className="size-4" />
				</div>
				<span className="min-w-0 flex-1">
					<span
						title={entry.name}
						className="block truncate text-sm"
					>
						{entry.name}
					</span>
					<span className="block truncate text-xs">{t("playlistDegraded")}</span>
				</span>
			</li>
		)
	}

	return (
		<PlaylistLinkRow
			playlist={entry.playlist}
			selected={selected}
		/>
	)
}

function PlaylistLinkRow({ playlist, selected }: { playlist: Playlist; selected: boolean }) {
	const { t } = useTranslation("audio")
	const { t: tCommon } = useTranslation("common")
	const now = useNowMinute()
	const coverUrl = useKnownCoverUrl(playlist.files[0])

	return (
		<li className="group/prow relative">
			<Link
				to="/playlists"
				search={{ playlist: playlist.uuid }}
				aria-current={selected ? "page" : undefined}
				className={ROW_CLASS}
			>
				<PlaylistArtwork
					uuid={playlist.uuid}
					coverUrl={coverUrl}
					className="size-8 rounded-lg"
					iconClassName="size-4"
				/>
				{/* Room for the ⋯ trigger only while it shows, so a name isn't clipped short at rest. */}
				<span className="min-w-0 flex-1 group-focus-within/prow:pr-7 group-hover/prow:pr-7">
					<span
						title={playlist.name}
						className="block truncate font-medium"
					>
						{playlist.name}
					</span>
					<span className="block truncate text-xs text-muted-foreground">
						{t("playlistTrackCount", { count: playlist.files.length })} · {formatRelativeTime(playlist.updated, tCommon, now)}
					</span>
				</span>
			</Link>
			{/* A sibling of the Link, never inside it: an interactive element nested in an anchor is
			    invalid and swallows the navigation. */}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("playlistItemMenuTrigger")}
							className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity app-region-no-drag group-focus-within/prow:opacity-100 group-hover/prow:opacity-100 aria-expanded:opacity-100"
						>
							<MoreHorizontalIcon />
						</Button>
					}
				/>
				<PlaylistMenuContent
					playlist={playlist}
					playback
				/>
			</DropdownMenu>
		</li>
	)
}
