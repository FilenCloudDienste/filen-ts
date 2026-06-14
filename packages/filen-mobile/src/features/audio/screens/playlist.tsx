import { Fragment, useCallback, useState } from "react"
import useIsOnline from "@/hooks/useIsOnline"
import Header, { type HeaderItem } from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import { Platform, ActivityIndicator } from "react-native"
import { useResolveClassNames } from "uniwind"
import ListEmpty from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
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
import {
	buildSelectionMenuButtons,
	buildPlaylistMenuButtons,
	addTracksToPlaylistFlow
} from "@/features/audio/components/playlistMenuButtons"
import { driveItemDisplayName } from "@/lib/decryption"

export function Playlist() {
	const { t } = useTranslation()
	const isOnline = useIsOnline()
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const selectedTracks = usePlaylistTracksStore(useShallow(state => state.selectedTracks))
	const [searchQuery, setSearchQuery] = useState<string>("")
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

	const playlist = playlistsQuery.status === "success" ? (playlistsQuery.data.find(p => p.uuid === uuid) ?? null) : null

	if (playlistsQuery.status === "pending" || !playlist) {
		return (
			<Fragment>
				<Header
					title={t("playlists")}
					transparent={Platform.OS === "ios"}
					shadowVisible={false}
					backVisible={Platform.OS === "android"}
					backgroundColor={Platform.select({
						ios: undefined,
						default: bgBackgroundSecondary.backgroundColor as string
					})}
					leftItems={Platform.select({
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
					})}
				/>
				<SafeAreaView
					className="flex-1 bg-background-secondary"
					edges={["left", "right"]}
				>
					{playlistsQuery.status === "pending" ? (
						<View className="flex-1 items-center justify-center bg-background-secondary">
							<ActivityIndicator
								size="large"
								color={textForeground.color as string}
							/>
						</View>
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
				</SafeAreaView>
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
			<Header
				title={tracksInSelectionMode ? t("selected", { count: selectedTracks.length }) : playlist.name}
				searchBarOptions={{
					placement: "integratedButton",
					placeholder: t("search_tracks"),
					onChangeText: e => setSearchQuery(e.nativeEvent.text),
					onCancelButtonPress: () => setSearchQuery(""),
					onClose: () => setSearchQuery(""),
					onOpen: () => setSearchQuery(""),
					allowToolbarIntegration: false,
					headerIconColor: textForeground.color,
					textColor: textForeground.color,
					barTintColor: "transparent",
					tintColor: textForeground.color,
					hintTextColor: textMutedForeground.color,
					shouldShowHintSearchIcon: true,
					hideNavigationBar: false,
					hideWhenScrolling: false,
					inputType: "text"
				}}
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
					data={visibleTracks}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: 300,
						flexGrow: 1
					}}
					ListEmptyComponent={() =>
						searchActive ? (
							<ListEmpty
								icon="search-outline"
								title={t("no_results")}
								description={t("no_results_description")}
							/>
						) : (
							<ListEmpty
								icon="musical-note-outline"
								title={t("no_tracks")}
								description={t("no_tracks_description")}
								action={
									<Button
										onPress={handleAddTracks}
										disabled={!isOnline}
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
			</SafeAreaView>
		</Fragment>
	)
}

export default Playlist
