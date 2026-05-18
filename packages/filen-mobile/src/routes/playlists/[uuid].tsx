import { memo, Fragment } from "react"
import Header from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import ListEmpty from "@/components/ui/listEmpty"
import { router, useLocalSearchParams } from "expo-router"
import usePlaylistsQuery from "@/queries/usePlaylists.query"
import { run, formatBytes, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import audio, { type PlaylistWithItems, useAudioQueue } from "@/lib/audio"
import { PressableScale } from "@/components/ui/pressables"
import type { DriveItem, DriveItemFileExtracted } from "@/types"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import useAudioMetadataQuery from "@/queries/useAudioMetadata.query"
import Image from "@/components/ui/image"
import ReorderableList, { reorderItems, useReorderableDrag } from "react-native-reorderable-list"
import { selectDriveItems } from "@/routes/driveSelect/[uuid]"
import prompts from "@/lib/prompts"
import type { MenuButton } from "@/components/ui/menu"
import { actionSheet } from "@/providers/actionSheet.provider"
import { selectPlaylists } from "@/routes/playlists"

const Track = memo(({ track, playlist }: { track: PlaylistWithItems["files"][number]; playlist: PlaylistWithItems }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const drag = useReorderableDrag()
	const { queueItem } = useAudioQueue()

	const isCurrent = !!queueItem && track.uuid === queueItem.item.data.uuid

	const audioMetadataQuery = useAudioMetadataQuery({
		type: "drive",
		data: {
			uuid: track.item.data.uuid
		}
	})

	return (
		<PressableScale
			className="bg-transparent flex-row items-center px-4 gap-3"
			onLongPress={drag}
			onPress={() => {
				actionSheet.show({
					buttons: [
						{
							title: "tbd_play",
							onPress: async () => {
								const result = await runWithLoading(async () => {
									const index = playlist.files.findIndex(f => f.uuid === track.uuid)

									await audio.replaceQueue({
										items: playlist.files.map(file => ({
											item: file.item,
											playlistUuid: playlist.uuid
										})),
										startingPosition: index >= 0 ? index : 0
									})

									await audio.play()
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						},
						{
							title: "tbd_add_to_queue",
							onPress: async () => {
								const result = await runWithLoading(async () => {
									const queueLengthBefore = audio.getQueue().length

									await audio.addToQueue({
										item: {
											playlistUuid: playlist.uuid,
											item: track.item
										}
									})

									if (queueLengthBefore === 0) {
										await audio.play()
									}
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						},
						{
							title: "tbd_add_to_playlist",
							onPress: async () => {
								const selectResult = await run(async () => {
									return await selectPlaylists({
										multiple: true,
										playlistUuidsToExclude: [playlist.uuid]
									})
								})

								if (!selectResult.success) {
									console.error(selectResult.error)
									alerts.error(selectResult.error)

									return
								}

								if (selectResult.data.cancelled || selectResult.data.selectedPlaylists.length === 0) {
									return
								}

								const selectedPlaylists = selectResult.data.selectedPlaylists

								const result = await runWithLoading(async () => {
									await Promise.all(
										selectedPlaylists.map(async selectedPlaylist => {
											const existingFile = selectedPlaylist.files.find(f => f.uuid === track.uuid)

											if (existingFile) {
												return
											}

											await audio.savePlaylist({
												playlist: {
													...selectedPlaylist,
													files: [
														...selectedPlaylist.files,
														{
															uuid: track.uuid,
															name: track.name,
															mime: track.mime,
															size: track.size,
															bucket: track.bucket,
															key: track.key,
															version: track.version,
															chunks: track.chunks,
															region: track.region,
															playlist: selectedPlaylist.uuid,
															item: track.item
														}
													]
												}
											})
										})
									)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						},
						{
							title: "tbd_remove_from_playlist",
							destructive: true,
							onPress: async () => {
								const result = await runWithLoading(async () => {
									await audio.savePlaylist({
										playlist: {
											...playlist,
											files: playlist.files.filter(f => f.uuid !== track.uuid)
										}
									})
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						},
						{
							title: "tbd_close",
							cancel: true
						}
					]
				})
			}}
		>
			{audioMetadataQuery.status === "success" && audioMetadataQuery.data?.pictureBase64 ? (
				<Image
					className={cn(
						"size-10 rounded-lg bg-background-tertiary",
						isCurrent ? "border border-blue-500" : "border border-transparent"
					)}
					source={audioMetadataQuery.data.pictureBase64}
					contentFit="contain"
					cachePolicy="disk"
					recyclingKey={`toolbar-audio-picture-${track.item.data.uuid}`}
				/>
			) : (
				<View
					className={cn(
						"bg-background-tertiary size-10 rounded-lg flex-row items-center justify-center",
						isCurrent ? "border border-blue-500" : "border border-transparent"
					)}
				>
					<Ionicons
						name="musical-note"
						size={16}
						color={textForeground.color}
					/>
				</View>
			)}
			<View className="flex-col bg-transparent flex-1 border-b border-border py-2.5">
				<Text
					numberOfLines={1}
					ellipsizeMode="middle"
					className="shrink-0"
				>
					{audioMetadataQuery.status === "success" && audioMetadataQuery.data?.title ? audioMetadataQuery.data.title : track.name}
				</Text>
				<Text
					numberOfLines={1}
					ellipsizeMode="middle"
					className="shrink-0 text-xs text-muted-foreground"
				>
					{audioMetadataQuery.status === "success" && audioMetadataQuery.data?.artist
						? `${audioMetadataQuery.data.artist} • ${formatBytes(track.size)}`
						: formatBytes(track.size)}
				</Text>
			</View>
		</PressableScale>
	)
})

const Playlist = memo(() => {
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const { uuid } = useLocalSearchParams<{
		uuid?: string
	}>()

	const playlistsQuery = usePlaylistsQuery({
		enabled: false
	})

	const playlist = playlistsQuery.status === "success" ? playlistsQuery.data.find(p => p.uuid === uuid) : null

	if (!playlist) {
		return null
	}

	return (
		<Fragment>
			<Header
				title={playlist.name}
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
				rightItems={[
					{
						type: "menu",
						props: {
							type: "dropdown",
							hitSlop: 20,
							buttons: [
								{
									id: "rename",
									icon: "edit",
									title: "tbd_rename_playlist",
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_rename_playlist",
												message: "tbd_enter_playlist_name",
												placeholder: "tbd_playlist_name_placeholder",
												cancelText: "tbd_cancel",
												okText: "tbd_rename",
												defaultValue: playlist.name
											})
										})

										if (!promptResult.success) {
											console.error(promptResult.error)
											alerts.error(promptResult.error)

											return
										}

										if (promptResult.data.cancelled || promptResult.data.type !== "string") {
											return
										}

										const newName = promptResult.data.value.trim()

										if (newName.length === 0) {
											return
										}

										const result = await runWithLoading(async () => {
											await audio.savePlaylist({
												playlist: {
													...playlist,
													name: newName,
													updated: Date.now()
												}
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								},
								...(playlist.files.length > 0
									? ([
											{
												id: "play",
												title: "tbd_play",
												onPress: async () => {
													const result = await runWithLoading(async () => {
														await audio.clearQueue()

														await audio.replaceQueue({
															items: playlist.files.map(file => ({
																item: file.item,
																playlistUuid: playlist.uuid
															})),
															startingPosition: 0
														})

														await audio.play()
													})

													if (!result.success) {
														console.error(result.error)
														alerts.error(result.error)

														return
													}
												}
											},
											{
												id: "addToQueue",
												title: "tbd_add_to_queue",
												onPress: async () => {
													const result = await runWithLoading(async () => {
														const queueLengthBefore = audio.getQueue().length

														await Promise.all(
															playlist.files.map(async file => {
																await audio.addToQueue({
																	item: {
																		playlistUuid: playlist.uuid,
																		item: file.item
																	}
																})
															})
														)

														if (queueLengthBefore === 0) {
															await audio.play()
														}
													})

													if (!result.success) {
														console.error(result.error)
														alerts.error(result.error)

														return
													}
												}
											}
										] satisfies MenuButton[])
									: []),
								{
									id: "add",
									icon: "plus",
									title: "tbd_add_tracks",
									onPress: async () => {
										const selectDriveItemsResult = await run(async () => {
											return await selectDriveItems({
												type: "multiple",
												files: true,
												directories: false,
												items: playlist.files.map(file => file.item),
												previewType: "audio"
											})
										})

										if (!selectDriveItemsResult.success) {
											console.error(selectDriveItemsResult.error)
											alerts.error(selectDriveItemsResult.error)

											return
										}

										if (
											selectDriveItemsResult.data.cancelled ||
											selectDriveItemsResult.data.selectedItems.length === 0
										) {
											return
										}

										const currentFilesUuids = new Set(playlist.files.map(file => file.item.data.uuid))
										const items = selectDriveItemsResult.data.selectedItems
											.filter(
												(
													item
												): item is {
													type: "driveItem"
													data: DriveItem
												} =>
													item.type === "driveItem" &&
													!currentFilesUuids.has(item.data.data.uuid) &&
													Boolean(item.data.data.decryptedMeta) &&
													(item.data.type === "file" ||
														item.data.type === "sharedFile" ||
														item.data.type === "sharedRootFile")
											)
											.map(item => item.data) as DriveItemFileExtracted[]

										if (items.length === 0) {
											return
										}

										const result = await runWithLoading(async () => {
											await audio.savePlaylist({
												playlist: {
													...playlist,
													files: [
														...playlist.files,
														...items.map(item => ({
															uuid: item.data.uuid,
															name: item.data.decryptedMeta?.name ?? item.data.uuid,
															mime: item.data.decryptedMeta?.mime ?? "application/octet-stream",
															size: Number(item.data.size),
															bucket: item.data.bucket,
															key: item.data.decryptedMeta?.key ?? "",
															version: item.data.decryptedMeta?.version
																? Number(item.data.decryptedMeta?.version)
																: 0,
															chunks: Number(item.data.chunks),
															region: item.data.region,
															playlist: playlist.uuid,
															item
														}))
													]
												}
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								},
								{
									id: "delete",
									icon: "delete",
									title: "tbd_delete_playlist",
									destructive: true,
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: "tbd_delete_playlist",
												message: "tbd_delete_playlist_confirm",
												cancelText: "tbd_cancel",
												okText: "tbd_delete",
												destructive: true
											})
										})

										if (!promptResult.success) {
											console.error(promptResult.error)
											alerts.error(promptResult.error)

											return
										}

										if (promptResult.data.cancelled) {
											return
										}

										const result = await runWithLoading(async () => {
											await audio.deletePlaylist({
												playlist
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}

										router.back()
									}
								}
							]
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
							await audio.savePlaylist({
								playlist: {
									...playlist,
									files: reorderItems(playlist.files, from, to)
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
							title="tbd_no_tracks"
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
})

export default Playlist
