import { useTranslation } from "react-i18next"
import { Link, useSearch } from "@tanstack/react-router"
import { ListMusicIcon, PlusIcon } from "lucide-react"
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
import { DropdownMenu } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"

// The shell's playlists contextual sidebar: a resizable panel like notes/chats, one row per playlist.
// Rows link to /playlists with an always-explicit `playlist` param (see routes/_app/playlists.tsx);
// create/rename/delete open the shared PlaylistDialogsHost the route screen mounts.
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
		<ResizableSidebarPanel
			module="playlists"
			resizeLabel={t("playlistsSidebarResize")}
		>
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
		</ResizableSidebarPanel>
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

	// The wrapper is the hover group and the no-drag region, like the notes/chats/drive rows: the whole
	// row, ⋯ included, must be outside the panel's Electron drag region for hover to reach it. Highlight
	// keys on `selected` rather than TanStack's data-status: with no (or a stale) `playlist` param the view
	// shows the last opened or first playlist, which no Link's own search matches.
	return (
		<li
			className={cn(
				"group flex items-center gap-1 rounded-xl pr-1 transition-colors app-region-no-drag",
				selected
					? "bg-sidebar-accent text-sidebar-accent-foreground"
					: "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground has-aria-expanded:bg-sidebar-accent/60"
			)}
		>
			<Link
				to="/playlists"
				search={{ playlist: playlist.uuid }}
				aria-current={selected ? "page" : undefined}
				className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-1.5 pl-1.5 text-sm focus-ring outline-none"
			>
				<PlaylistArtwork
					uuid={playlist.uuid}
					coverUrl={coverUrl}
					className="size-8 rounded-lg"
					iconClassName="size-4"
				/>
				<span className="min-w-0 flex-1">
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
				<RowMenuTrigger
					label={t("playlistItemMenuTrigger")}
					reveal="plain"
				/>
				<PlaylistMenuContent
					playlist={playlist}
					playback
				/>
			</DropdownMenu>
		</li>
	)
}
