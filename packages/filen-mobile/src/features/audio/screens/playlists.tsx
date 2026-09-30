import { Fragment, useEffect, useState } from "react"
import useOnUnmountWithLatest from "@/hooks/useOnUnmountWithLatest"
import { type HeaderItem } from "@/components/ui/header"
import SettingsHeader from "@/components/ui/settingsHeader"
import { ScreenBody } from "@/components/ui/safeAreaView"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty, { NoResultsEmpty } from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
import useClearSelectionOnFocusChange from "@/hooks/useClearSelectionOnFocusChange"
import { router } from "@/lib/router"
import usePlaylistsQuery from "@/features/audio/queries/usePlaylists.query"
import { run, pruneSelection, createPlaylist } from "@filen/shared"
import alerts from "@/lib/alerts"
import audio, { type PlaylistWithItems } from "@/features/audio/audio"
import { inputPrompt } from "@/lib/promptFlow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { randomUUID } from "expo-crypto"
import events from "@/lib/events"
import usePlaylistsStore from "@/features/audio/store/usePlaylists.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import { useTranslation } from "react-i18next"
import type { MenuButton } from "@/components/ui/menu"
import { selectAllMenuButton } from "@/components/ui/selectAllMenuButton"
import { usePlaylistSelectOptions } from "@/features/audio/playlistsSelect"
import PlaylistRow from "@/features/audio/components/playlistRow"
import logger from "@/lib/logger"

const clearSelectedPlaylists = () => usePlaylistsStore.getState().clearSelectedPlaylists()

export function Playlists() {
	const { t } = useTranslation()
	const selectedPlaylists = usePlaylistsStore(useShallow(state => state.selectedPlaylists))
	const [searchQuery, setSearchQuery] = useState<string>("")
	const selectOptions = usePlaylistSelectOptions()

	const playlistsQuery = usePlaylistsQuery()

	useOnUnmountWithLatest(selectOptions, latestSelectOptions => {
		if (latestSelectOptions) {
			events.emit("playlistsSelect", {
				id: latestSelectOptions.id,
				cancelled: true
			})
		}
	})

	useClearSelectionOnFocusChange(clearSelectedPlaylists)

	const allPlaylists =
		playlistsQuery.data ? [...playlistsQuery.data].sort((a, b) => b.updated - a.updated) : ([] as PlaylistWithItems[])

	// Read the DATA, not the last fetch's verdict (#103).
	const playlistsData = playlistsQuery.data ?? null

	// Stale-selection purge: a refetch (e.g. pull-to-refresh) can drop a playlist that was deleted
	// on another device while it's still selected. Intersect the selection against the freshest data
	// by uuid so the header count and any bulk delete don't target a phantom (#AU-15).
	useEffect(() => {
		if (!playlistsData) {
			return
		}

		const liveUuids = new Set(playlistsData.map(playlist => playlist.uuid))
		const selected = usePlaylistsStore.getState().selectedPlaylists
		const kept = pruneSelection(selected, playlist => liveUuids.has(playlist.uuid))

		if (kept !== selected) {
			usePlaylistsStore.getState().setSelectedPlaylists(kept)
		}
	}, [playlistsData])

	const searchActive = searchQuery.trim().length > 0

	const visiblePlaylists = (() => {
		if (!searchActive) {
			return allPlaylists
		}

		const normalized = searchQuery.trim().toLowerCase()

		return allPlaylists.filter(playlist => playlist.name.toLowerCase().includes(normalized))
	})()

	// Same indexed lookup as playlistMenuButtons — identical semantics, no nested scan.
	const selectedPlaylistUuids = new Set(selectedPlaylists.map(selected => selected.uuid))
	const allVisibleSelected =
		visiblePlaylists.length > 0 && visiblePlaylists.every(playlist => selectedPlaylistUuids.has(playlist.uuid))

	const handleCreatePlaylist = async () => {
		const newName = await inputPrompt(
			{
				title: t("new_playlist"),
				message: t("enter_playlist_name"),
				placeholder: t("playlist_name_placeholder"),
				cancelText: t("cancel"),
				okText: t("create")
			},
			{ tag: "audio", message: "create playlist prompt failed", level: "error" },
			{ trim: true }
		)

		if (newName === null) {
			return
		}

		const result = await runWithLoading(async () => {
			await audio.savePlaylist({
				playlist: createPlaylist(randomUUID(), newName, Date.now())
			})
		})

		if (!result.success) {
			logger.error("audio", "create playlist failed", { error: result.error })
			alerts.error(result.error)
		}
	}

	const headerLeftItems: HeaderItem[] | undefined =
		selectedPlaylists.length > 0 && !selectOptions
			? [
					{
						type: "clearSelection",
						onPress: () => usePlaylistsStore.getState().clearSelectedPlaylists()
					}
				]
			: undefined

	const headerRightItems = ((): HeaderItem[] => {
		const menuButtons: MenuButton[] = []

		if (selectedPlaylists.length > 0 && !selectOptions) {
			menuButtons.push(
				selectAllMenuButton({
					t,
					allSelected: allVisibleSelected,
					onClear: () => usePlaylistsStore.getState().clearSelectedPlaylists(),
					// An empty filtered set would replace the selection with [].
					onSelectAll: () => {
						if (visiblePlaylists.length === 0) {
							return
						}

						usePlaylistsStore.getState().selectAllPlaylists(visiblePlaylists)
					}
				})
			)

			menuButtons.push({
				id: "bulkDelete",
				title: t("delete_selected"),
				icon: "delete",
				destructive: true,
				requiresOnline: true,
				onPress: async () => {
					await runBulk({
						items: selectedPlaylists,
						clearSelection: () => usePlaylistsStore.getState().clearSelectedPlaylists(),
						confirm: {
							title: t("delete_selected"),
							message: t("delete_selected_playlists_confirm"),
							okText: t("delete"),
							cancelText: t("cancel"),
							destructive: true
						},
						op: playlist => audio.deletePlaylist({ playlist })
					})
				}
			})
		} else {
			menuButtons.push({
				id: "create",
				icon: "plus",
				title: t("create_playlist"),
				requiresOnline: true,
				onPress: handleCreatePlaylist
			})
		}

		return [
			{
				type: "ellipsisMenu",
				buttons: menuButtons
			}
		]
	})()

	const title = selectedPlaylists.length > 0 && !selectOptions ? t("selected", { count: selectedPlaylists.length }) : t("playlists")

	return (
		<Fragment>
			<SettingsHeader
				title={title}
				icon="close"
				onDismiss={() => {
					router.back()
				}}
				leftItems={headerLeftItems}
				rightItems={headerRightItems}
				search={{
					placeholder: t("search_playlists"),
					onChangeText: setSearchQuery
				}}
			/>
			<ScreenBody>
				<VirtualList
					className="flex-1 bg-background-secondary"
					data={visiblePlaylists}
					loading={playlistsQuery.status === "pending"}
					contentContainerStyle={{
						paddingBottom: 300
					}}
					requiresOnline={true}
					onRefresh={async () => {
						const result = await run(async () => {
							return await playlistsQuery.refetch()
						})

						if (!result.success) {
							logger.error("audio", "playlists refetch failed", { error: result.error })
							alerts.error(result.error)
						}
					}}
					emptyComponent={() =>
						searchActive ? (
							<NoResultsEmpty />
						) : (
							<ListEmpty
								icon="musical-note-outline"
								title={t("no_playlists")}
								description={t("no_playlists_description")}
								action={
									<Button
										onPress={handleCreatePlaylist}
										requiresOnline
									>
										{t("create_playlist")}
									</Button>
								}
							/>
						)
					}
					renderItem={({ item: playlist }) => {
						return (
							<PlaylistRow
								playlist={playlist}
								selectOptions={selectOptions ?? undefined}
							/>
						)
					}}
					keyExtractor={playlist => playlist.uuid}
				/>
			</ScreenBody>
		</Fragment>
	)
}

export default Playlists
