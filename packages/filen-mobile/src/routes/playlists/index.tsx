import { memo, Fragment, useEffect, useCallback } from "react"
import { onlineManager } from "@tanstack/react-query"
import Header, { type HeaderItem } from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
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
import { runBulk } from "@/lib/bulkOps"
import type { MenuButton } from "@/components/ui/menu"

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
	const arePlaylistsSelected = usePlaylistsStore(useShallow(state => state.selectedPlaylists.length > 0))

	const isCurrent = !!queueItem && playlist.uuid === queueItem.playlistUuid
	const disabled =
		(selectOptions?.playlistUuidsToExclude?.includes(playlist.uuid) ?? false) ||
		(selectOptions ? !isSelected && !selectOptions.multiple : false)

	const onPress = () => {
		if (disabled) {
			return
		}

		if (selectOptions) {
			usePlaylistsStore.getState().toggleSelectedPlaylist(playlist)

			return
		}

		// In bulk-selection mode (selection started via the actionSheet "Select"
		// item), a regular tap toggles the row instead of navigating into the
		// playlist. Matches the Drive / Notes / Chats pattern.
		if (arePlaylistsSelected) {
			usePlaylistsStore.getState().toggleSelectedPlaylist(playlist)

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
			className={cn(
				"flex-row items-center px-4 gap-3",
				disabled && "opacity-50 pointer-events-none",
				isSelected && !selectOptions ? "bg-background-tertiary" : "bg-transparent"
			)}
			onPress={onPress}
			onLongPress={() => {
				if (selectOptions) {
					return
				}

				actionSheet.show({
					buttons: [
						{
							title: "tbd_select",
							onPress: () => {
								usePlaylistsStore.getState().toggleSelectedPlaylist(playlist)
							}
						},
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

												const { droppedUndecryptable } = await audio.replaceQueue({
													items: playlist.files.map(file => ({
														item: file.item,
														playlistUuid: playlist.uuid
													})),
													startingPosition: 0
												})

												if (droppedUndecryptable) {
													alerts.normal("tbd_cannot_decrypt_toast")
												}

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

												const addedResults = await Promise.all(
													playlist.files.map(async file => {
														return await audio.addToQueue({
															item: {
																playlistUuid: playlist.uuid,
																item: file.item
															}
														})
													})
												)

												if (addedResults.some(added => !added)) {
													alerts.normal("tbd_cannot_decrypt_toast")
												}

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
			{(selectOptions || arePlaylistsSelected) && (
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
	const selectedPlaylists = usePlaylistsStore(useShallow(state => state.selectedPlaylists))
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
			usePlaylistsStore.getState().clearSelectedPlaylists()

			return () => {
				usePlaylistsStore.getState().clearSelectedPlaylists()
			}
		}, [])
	)

	const allPlaylists =
		playlistsQuery.status === "success" ? playlistsQuery.data.sort((a, b) => b.updated - a.updated) : ([] as PlaylistWithItems[])

	const headerLeftItems = ((): HeaderItem[] | undefined => {
		if (selectedPlaylists.length > 0 && !selectOptions) {
			return [
				{
					type: "button",
					icon: {
						name: "close-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							usePlaylistsStore.getState().clearSelectedPlaylists()
						}
					}
				}
			]
		}

		return Platform.select({
			ios: [
				{
					type: "button",
					icon: {
						name: "close",
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
	})()

	const headerRightItems = ((): HeaderItem[] => {
		const menuButtons: MenuButton[] = []

		if (selectedPlaylists.length > 0 && !selectOptions) {
			menuButtons.push({
				id: "selectAll",
				title: selectedPlaylists.length === allPlaylists.length ? "tbd_deselect_all" : "tbd_select_all",
				icon: "select",
				onPress: () => {
					if (selectedPlaylists.length === allPlaylists.length) {
						usePlaylistsStore.getState().clearSelectedPlaylists()

						return
					}

					usePlaylistsStore.getState().selectAllPlaylists(allPlaylists)
				}
			})

			menuButtons.push({
				id: "bulkDelete",
				title: "tbd_delete_selected",
				icon: "delete",
				destructive: true,
				requiresOnline: true,
				onPress: async () => {
					await runBulk({
						items: selectedPlaylists,
						clearSelection: () => usePlaylistsStore.getState().clearSelectedPlaylists(),
						confirm: {
							title: "tbd_delete_selected",
							message: "tbd_delete_selected_playlists_confirm",
							okText: "tbd_delete",
							cancelText: "tbd_cancel",
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
				title: "tbd_create_playlist",
				requiresOnline: true,
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
			})
		}

		return [
			{
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: menuButtons
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
		]
	})()

	const title = selectedPlaylists.length > 0 && !selectOptions ? `${selectedPlaylists.length} tbd_selected` : "tbd_playlists"

	return (
		<Fragment>
			<Header
				title={title}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={headerLeftItems}
				rightItems={headerRightItems}
			/>
			<SafeAreaView
				className="bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					className="flex-1 bg-background-secondary"
					data={allPlaylists}
					loading={playlistsQuery.status !== "success"}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: 300
					}}
					onRefresh={async () => {
						if (!onlineManager.isOnline()) {
							return
						}

						const result = await run(async () => {
							return await playlistsQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="musical-note-outline"
							title="tbd_no_playlists"
						/>
					)}
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
