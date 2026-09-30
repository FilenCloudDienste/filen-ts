import { Fragment, useEffect, useState } from "react"
import { LoadingView } from "@/components/ui/loadingView"
import SettingsHeader from "@/components/ui/settingsHeader"
import { ScreenBody } from "@/components/ui/safeAreaView"
import ListEmpty, { NoResultsEmpty } from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
import { useLocalSearchParams } from "expo-router"
import useClearSelectionOnFocusChange from "@/hooks/useClearSelectionOnFocusChange"
import { router } from "@/lib/router"
import usePlaylistsQuery from "@/features/audio/queries/usePlaylists.query"
import alerts from "@/lib/alerts"
import audio from "@/features/audio/audio"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import ReorderableList from "react-native-reorderable-list"
import usePlaylistTracksStore from "@/features/audio/store/usePlaylistTracks.store"
import { pruneSelection } from "@filen/shared"
import { useShallow } from "zustand/shallow"
import { useTranslation } from "react-i18next"
import Track from "@/features/audio/components/track"
import {
	buildSelectionMenuButtons,
	buildPlaylistMenuButtons,
	addTracksToPlaylistFlow
} from "@/features/audio/components/playlistMenuButtons"
import { driveItemDisplayName } from "@/lib/decryption"
import logger from "@/lib/logger"

const clearSelectedTracks = () => usePlaylistTracksStore.getState().clearSelectedTracks()

export function Playlist() {
	const { t } = useTranslation()
	const selectedTracks = usePlaylistTracksStore(useShallow(state => state.selectedTracks))
	const [searchQuery, setSearchQuery] = useState<string>("")
	const { uuid } = useLocalSearchParams<{
		uuid?: string
	}>()

	useClearSelectionOnFocusChange(clearSelectedTracks)

	const playlistsQuery = usePlaylistsQuery({
		enabled: false
	})

	// Read the DATA (#103): gating on status dismissed this screen whenever the device was offline.
	const playlist = playlistsQuery.data?.find(p => p.uuid === uuid) ?? null

	const trackFiles = playlist?.files

	// Stale-selection purge: a refetch (e.g. pull-to-refresh) can drop a track that was removed
	// remotely while it's still selected. Intersect the selection against the freshest track list
	// by uuid so the header count and any bulk action don't target a phantom (#AU-15). Declared
	// before the early return below to keep hook order stable.
	useEffect(() => {
		if (!trackFiles) {
			return
		}

		const liveUuids = new Set(trackFiles.map(file => file.uuid))
		const selected = usePlaylistTracksStore.getState().selectedTracks
		const kept = pruneSelection(selected, file => liveUuids.has(file.uuid))

		if (kept !== selected) {
			usePlaylistTracksStore.getState().setSelectedTracks(kept)
		}
	}, [trackFiles])

	if (playlistsQuery.status === "pending" || !playlist) {
		return (
			<Fragment>
				<SettingsHeader
					title={t("playlists")}
					icon="chevron-back-outline"
					onDismiss={() => {
						router.back()
					}}
				/>
				<ScreenBody>
					{playlistsQuery.status === "pending" ? (
						<LoadingView />
					) : (
						<ListEmpty
							icon="warning-outline"
							title={t("playlist_not_found")}
							description={t("playlist_not_found_description")}
							action={
								<Button
									onPress={() => {
										router.back()
									}}
								>
									{t("go_back")}
								</Button>
							}
						/>
					)}
				</ScreenBody>
			</Fragment>
		)
	}

	const tracksInSelectionMode = selectedTracks.length > 0

	const searchActive = searchQuery.trim().length > 0

	const visibleTracks = (() => {
		if (!searchActive) {
			return playlist.files
		}

		const normalized = searchQuery.trim().toLowerCase()

		return playlist.files.filter(track => driveItemDisplayName(track.item).toLowerCase().includes(normalized))
	})()

	const baseRightMenuButtons = tracksInSelectionMode ? buildSelectionMenuButtons({ t, playlist, selectedTracks, visibleTracks }) : []

	const currentPlaylist = playlist

	async function handleAddTracks() {
		await addTracksToPlaylistFlow({ playlist: currentPlaylist })
	}

	return (
		<Fragment>
			<SettingsHeader
				title={tracksInSelectionMode ? t("selected", { count: selectedTracks.length }) : playlist.name}
				search={{
					placeholder: t("search_tracks"),
					onChangeText: setSearchQuery
				}}
				icon="chevron-back-outline"
				onDismiss={() => {
					router.back()
				}}
				leftItems={
					tracksInSelectionMode
						? [
								{
									type: "clearSelection",
									onPress: () => usePlaylistTracksStore.getState().clearSelectedTracks()
								}
							]
						: undefined
				}
				rightItems={[
					{
						type: "ellipsisMenu",
						buttons: tracksInSelectionMode ? baseRightMenuButtons : buildPlaylistMenuButtons({ t, playlist })
					}
				]}
			/>
			<ScreenBody>
				<ReorderableList
					style={{
						flex: 1
					}}
					onReorder={async ({ from, to }) => {
						const result = await runWithLoading(async () => {
							// reorderPlaylistFile applies the move against the FRESHEST order under a per-playlist
							// write lock, so rapid sequential reorders compose instead of overwriting the cloud
							// copy with a stale order captured in this handler's render snapshot.
							await audio.reorderPlaylistFile({
								playlist,
								from,
								to
							})
						})

						if (!result.success) {
							logger.error("audio", "reorder tracks failed", { playlistUuid: playlist.uuid, error: result.error })
							alerts.error(result.error)

							return
						}
					}}
					data={visibleTracks}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: 300,
						flexGrow: 1
					}}
					ListEmptyComponent={() =>
						searchActive ? (
							<NoResultsEmpty />
						) : (
							<ListEmpty
								icon="musical-note-outline"
								title={t("no_tracks")}
								description={t("no_tracks_description")}
								action={
									<Button
										onPress={handleAddTracks}
										requiresOnline
									>
										{t("add_tracks")}
									</Button>
								}
							/>
						)
					}
					renderItem={({ item: track }) => {
						return (
							<Track
								track={track}
								playlist={playlist}
								reorderDisabled={searchActive}
							/>
						)
					}}
					keyExtractor={track => track.uuid}
				/>
			</ScreenBody>
		</Fragment>
	)
}

export default Playlist
