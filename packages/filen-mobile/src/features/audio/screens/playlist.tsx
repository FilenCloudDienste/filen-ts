import { Fragment, useCallback } from "react"
import Header, { type HeaderItem } from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import ListEmpty from "@/components/ui/listEmpty"
import { router, useLocalSearchParams, useFocusEffect } from "expo-router"
import usePlaylistsQuery, { playlistsQueryGet } from "@/features/audio/queries/usePlaylists.query"
import alerts from "@/lib/alerts"
import audio from "@/features/audio/audio"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import ReorderableList, { reorderItems } from "react-native-reorderable-list"
import usePlaylistTracksStore from "@/features/audio/store/usePlaylistTracks.store"
import { useShallow } from "zustand/shallow"
import { useTranslation } from "react-i18next"
import Track from "@/features/audio/components/track"
import { buildSelectionMenuButtons, buildPlaylistMenuButtons } from "@/features/audio/components/playlistMenuButtons"

export function Playlist() {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const selectedTracks = usePlaylistTracksStore(useShallow(state => state.selectedTracks))
	const { uuid } = useLocalSearchParams<{
		uuid?: string
	}>()

	useFocusEffect(
		useCallback(() => {
			usePlaylistTracksStore.getState().clearSelectedTracks()

			return () => {
				usePlaylistTracksStore.getState().clearSelectedTracks()
			}
		}, [])
	)

	const playlistsQuery = usePlaylistsQuery({
		enabled: false
	})

	const playlist = playlistsQuery.status === "success" ? playlistsQuery.data.find(p => p.uuid === uuid) : null

	if (!playlist) {
		return null
	}

	const tracksInSelectionMode = selectedTracks.length > 0

	const baseRightMenuButtons = tracksInSelectionMode ? buildSelectionMenuButtons({ t, playlist, selectedTracks }) : []

	return (
		<Fragment>
			<Header
				title={tracksInSelectionMode ? t("selected", { count: selectedTracks.length }) : playlist.name}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={
					tracksInSelectionMode
						? ([
								{
									type: "button",
									icon: {
										name: "close-outline",
										color: textForeground.color,
										size: 20
									},
									props: {
										onPress: () => {
											usePlaylistTracksStore.getState().clearSelectedTracks()
										}
									}
								}
							] satisfies HeaderItem[])
						: Platform.select({
								ios: [
									{
										type: "button",
										icon: {
											name: "chevron-back-outline",
											color: textForeground.color,
											size: 20
										},
										props: {
											onPress: () => {
												router.back()
											}
										}
									}
								],
								default: undefined
							})
				}
				rightItems={[
					{
						type: "menu",
						props: {
							type: "dropdown",
							hitSlop: 20,
							buttons: tracksInSelectionMode ? baseRightMenuButtons : buildPlaylistMenuButtons({ t, playlist })
						},
						triggerProps: {
							hitSlop: 20
						},
						icon: {
							name: "ellipsis-horizontal",
							size: 24,
							color: textForeground.color
						}
					}
				]}
			/>
			<SafeAreaView
				className="bg-background-secondary"
				edges={["left", "right"]}
			>
				<ReorderableList
					style={{
						flex: 1
					}}
					onReorder={async ({ from, to }) => {
						const result = await runWithLoading(async () => {
							// Read the freshest playlist from the query cache so rapid sequential reorders
							// compose on each other instead of overwriting the cloud copy with a stale order
							// captured in this handler's render snapshot.
							const latestPlaylist = playlistsQueryGet()?.find(p => p.uuid === playlist.uuid) ?? playlist

							await audio.savePlaylist({
								playlist: {
									...latestPlaylist,
									files: reorderItems(latestPlaylist.files, from, to)
								}
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}}
					data={playlist.files}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: 300,
						flexGrow: 1
					}}
					ListEmptyComponent={() => (
						<ListEmpty
							icon="musical-note-outline"
							title={t("no_tracks")}
						/>
					)}
					renderItem={({ item: track }) => {
						return (
							<Track
								track={track}
								playlist={playlist}
							/>
						)
					}}
					keyExtractor={track => track.uuid}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default Playlist
