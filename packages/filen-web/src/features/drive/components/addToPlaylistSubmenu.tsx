import { useTranslation } from "react-i18next"
import { ListMusicIcon, PlusIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { type DirectoryTreeMenuFamily } from "@/features/drive/components/directoryTreeSubmenu"
import { usePlaylistsQuery } from "@/features/audio/queries/playlists"
import { addSelectionToPlaylist } from "@/features/audio/lib/addTracks"
import { Spinner } from "@/components/ui/spinner"

// Add to playlist in the item menus, the bulk context menu and (entries only, inside BulkActionMenuButton) the
// selection bar: the user's playlists, then New playlist…. A pick adds the songs among `items` in one write. The
// content mounts only while open (Base UI portals), so the playlists query is read only then, from its cache when
// that is still fresh.

export interface AddToPlaylistEntriesProps {
	family: DirectoryTreeMenuFamily
	items: readonly DriveItem[]
	onNewPlaylist: () => void
}

export function AddToPlaylistEntries({ family, items, onNewPlaylist }: AddToPlaylistEntriesProps) {
	const { t } = useTranslation("drive")
	const query = usePlaylistsQuery()
	const { Item, Separator } = family
	const playlists = query.data?.flatMap(entry => (entry.status === "ok" ? [entry.playlist] : [])) ?? []

	return (
		<>
			{query.status === "pending" ? (
				<div className="flex h-7 items-center justify-center text-muted-foreground">
					<Spinner className="size-3.5" />
				</div>
			) : query.status === "error" && playlists.length === 0 ? (
				<Item disabled>{t("driveAddToPlaylistLoadError")}</Item>
			) : (
				playlists.map(playlist => (
					<Item
						key={playlist.uuid}
						onClick={() => {
							void addSelectionToPlaylist(playlist, items)
						}}
					>
						<ListMusicIcon aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate">{playlist.name}</span>
					</Item>
				))
			)}
			{query.status === "pending" || query.status === "error" || playlists.length > 0 ? <Separator /> : null}
			<Item onClick={onNewPlaylist}>
				<PlusIcon aria-hidden="true" />
				{t("driveAddToNewPlaylist")}
			</Item>
		</>
	)
}

export function AddToPlaylistSubmenu({ family, items, onNewPlaylist, disabled }: AddToPlaylistEntriesProps & { disabled: boolean }) {
	const { t } = useTranslation(["drive", "common"])
	const { Sub, SubTrigger, SubContent } = family
	const def = ACTION_DEFS.addToPlaylist

	return (
		<Sub>
			<SubTrigger
				disabled={disabled}
				title={disabled ? t("common:offlineActionDisabled") : undefined}
			>
				<def.icon aria-hidden="true" />
				{t(def.labelKey)}
			</SubTrigger>
			<SubContent className="max-w-72">
				<AddToPlaylistEntries
					family={family}
					items={items}
					onNewPlaylist={onNewPlaylist}
				/>
			</SubContent>
		</Sub>
	)
}
