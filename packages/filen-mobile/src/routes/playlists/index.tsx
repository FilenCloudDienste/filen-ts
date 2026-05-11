import { memo, Fragment, useEffect, useCallback } from "react"
import Header from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import VirtualList from "@/components/ui/virtualList"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import { router, useLocalSearchParams, useFocusEffect } from "expo-router"
import usePlaylistsQuery from "@/queries/usePlaylists.query"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import audio, { type PlaylistWithItems, useAudioQueue } from "@/lib/audio"
import { PressableScale } from "@/components/ui/pressables"
import { simpleDateNoTime } from "@/lib/time"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { randomUUID } from "expo-crypto"
import { actionSheet } from "@/providers/actionSheet.provider"
import { selectDriveItems } from "@/routes/driveSelect/[uuid]"
import type { DriveItemFileExtracted, DriveItem } from "@/types"
import { deserialize, serialize } from "@/lib/serializer"
import events from "@/lib/events"
import usePlaylistsStore from "@/stores/usePlaylists.store"
import { useShallow } from "zustand/shallow"
import { Checkbox } from "@/components/ui/checkbox"

export type SelectOptions = {
	id: string
	multiple: boolean
	playlistUuidsToExclude?: string[]
}

export async function selectPlaylists(options: Omit<SelectOptions, "id">): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedPlaylists: PlaylistWithItems[]
	  }
> {
	return new Promise(resolve => {
		const id = randomUUID()

		const sub = events.subscribe("playlistsSelect", data => {
			if (data.id === id) {
				sub.remove()

				if (data.cancelled || data.selectedPlaylists.length === 0) {
					resolve({
						cancelled: true
					})

					return
				}

				resolve({
					cancelled: false,
					selectedPlaylists: data.selectedPlaylists
				})
			}
		})

		router.push({
			pathname: "/selectPlaylists",
			params: {
				selectOptions: serialize({
					...options,
					id
				} satisfies SelectOptions)
			}
		})
	})
}

const Playlist = memo(({ playlist, selectOptions }: { playlist: PlaylistWithItems; selectOptions?: SelectOptions }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const { queueItem } = useAudioQueue()
	const isSelected = usePlaylistsStore(useShallow(state => state.selectedPlaylists.some(p => p.uuid === playlist.uuid)))

	const isCurrent = !!queueItem && playlist.uuid === queueItem.playlistUuid
	const disabled =
		(selectOptions?.playlistUuidsToExclude?.includes(playlist.uuid) ?? false) ||
		(selectOptions ? !isSelected && !selectOptions.multiple : false)

	const onPress = () => {
		if (disabled) {
			return
		}

		if (selectOptions) {
			usePlaylistsStore.getState().setSelectedPlaylists(prev => {
				if (prev.some(p => p.uuid === playlist.uuid)) {
					return prev.filter(p => p.uuid !== playlist.uuid)
				}

				return [...prev, playlist]
			})

			return
		}

		router.push({
			pathname: "/playlists/[uuid]",
			params: {
				uuid: playlist.uuid
			}
		})
	}

	return (
		<PressableScale
			className={cn("bg-transparent flex-row items-center px-4 gap-3", disabled && "opacity-50 pointer-events-none")}
			onPress={onPress}
			onLongPress={() => {
				if (selectOptions) {
					return
				}

				actionSheet.show({
					buttons: [
						{
							title: "tbd_rename",
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
							? [
									{
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
								]
							: []),
						{
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

								if (selectDriveItemsResult.data.cancelled || selectDriveItemsResult.data.selectedItems.length === 0) {
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
							title: "tbd_delete",
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
			{selectOptions && (
				<View className="flex-row h-full items-center justify-center bg-transparent shrink-0">
					<Checkbox
						value={isSelected}
						onValueChange={onPress}
						hitSlop={16}
						color={disabled ? "transparent" : undefined}
					/>
				</View>
			)}
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
			<View className="flex-col bg-transparent flex-1 border-b border-border py-2.5">
				<Text
					numberOfLines={1}
					ellipsizeMode="middle"
					className="shrink-0"
				>
					{playlist.name}
				</Text>
				<Text
					numberOfLines={1}
					ellipsizeMode="middle"
					className="shrink-0 text-xs text-muted-foreground"
				>
					{playlist.files.length} {playlist.files.length === 1 ? "tbd_track" : "tbd_tracks"}, tbd_updated{" "}
					{simpleDateNoTime(playlist.updated)}
				</Text>
			</View>
		</PressableScale>
	)
})

const Playlists = memo(() => {
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const { selectOptions: selectOptionsSerialized } = useLocalSearchParams<{
		selectOptions?: string
	}>()

	const selectOptions = (() => {
		if (!selectOptionsSerialized) {
			return null
		}

		try {
			const parsed = deserialize(selectOptionsSerialized) as SelectOptions

			return {
				multiple: parsed.multiple,
				playlistUuidsToExclude: parsed.playlistUuidsToExclude,
				id: parsed.id
			}
		} catch {
			return null
		}
	})()

	const playlistsQuery = usePlaylistsQuery()

	useEffect(() => {
		return () => {
			if (selectOptions) {
				events.emit("playlistsSelect", {
					id: selectOptions.id,
					cancelled: true
				})
			}
		}
	}, [selectOptions])

	useFocusEffect(
		useCallback(() => {
			usePlaylistsStore.getState().setSelectedPlaylists([])

			return () => {
				usePlaylistsStore.getState().setSelectedPlaylists([])
			}
		}, [])
	)

	return (
		<Fragment>
			<Header
				title="tbd_playlists"
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
									id: "create",
									icon: "plus",
									title: "tbd_create_playlist",
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_new_playlist",
												message: "tbd_enter_playlist_name",
												placeholder: "tbd_playlist_name_placeholder",
												cancelText: "tbd_cancel",
												okText: "tbd_create"
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
													name: newName,
													files: [],
													uuid: randomUUID(),
													updated: Date.now(),
													created: Date.now()
												}
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
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
				<VirtualList
					className="flex-1 bg-background-secondary"
					data={playlistsQuery.status === "success" ? playlistsQuery.data.sort((a, b) => b.updated - a.updated) : []}
					loading={playlistsQuery.status !== "success"}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: 300
					}}
					onRefresh={async () => {
						const result = await run(async () => {
							return await playlistsQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					emptyComponent={() => {
						return (
							<View className="flex-1 items-center justify-center bg-transparent gap-2 -mt-40">
								<Ionicons
									name="musical-note-outline"
									size={64}
									color={textMutedForeground.color}
								/>
								<Text>tbd_no_playlists</Text>
							</View>
						)
					}}
					renderItem={({ item: playlist }) => {
						return (
							<Playlist
								playlist={playlist}
								selectOptions={selectOptions ?? undefined}
							/>
						)
					}}
					keyExtractor={playlist => playlist.uuid}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Playlists
