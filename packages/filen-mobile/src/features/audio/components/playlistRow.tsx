import { useResolveClassNames } from "uniwind"
import { router } from "expo-router"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import audio, { type PlaylistWithItems, useAudioQueue } from "@/features/audio/audio"
import { PressableScale } from "@/components/ui/pressables"
import { simpleDateNoTime } from "@/lib/time"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { actionSheet, type ShowActionSheetOptions } from "@/providers/actionSheet.provider"
import { selectDriveItems } from "@/features/drive/screens/driveSelect"
import usePlaylistsStore from "@/features/audio/store/usePlaylists.store"
import { useShallow } from "zustand/shallow"
import { Checkbox } from "@/components/ui/checkbox"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"
import type { SelectOptions } from "@/features/audio/playlistsSelect"

function buildPlaylistRowButtons({
	t,
	playlist
}: {
	t: TFunction
	playlist: PlaylistWithItems
}): ShowActionSheetOptions["buttons"] {
	return [
		{
			title: t("select"),
			onPress: () => {
				usePlaylistsStore.getState().toggleSelectedPlaylist(playlist)
			}
		},
		{
			title: t("rename"),
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: t("rename_playlist"),
						message: t("enter_playlist_name"),
						placeholder: t("playlist_name_placeholder"),
						cancelText: t("cancel"),
						okText: t("rename"),
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
					await audio.renamePlaylist({
						playlist,
						name: newName
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
						title: t("play"),
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
									alerts.normal(t("cannot_decrypt_toast"))
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
						title: t("add_to_queue"),
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
									alerts.normal(t("cannot_decrypt_toast"))
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
			title: t("add_tracks"),
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

				const result = await runWithLoading(async () => {
					await audio.addFilesToPlaylist({
						playlist,
						items: selectDriveItemsResult.data.cancelled ? [] : selectDriveItemsResult.data.selectedItems
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
			title: t("delete"),
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("delete_playlist"),
						message: t("delete_playlist_confirm"),
						cancelText: t("cancel"),
						okText: t("delete"),
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
			title: t("close"),
			cancel: true
		}
	]
}

export function PlaylistRow({ playlist, selectOptions }: { playlist: PlaylistWithItems; selectOptions?: SelectOptions }) {
	const { t } = useTranslation()
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
					buttons: buildPlaylistRowButtons({ t, playlist })
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
					{t("tracks_updated", {
						count: playlist.files.length,
						date: simpleDateNoTime(playlist.updated)
					})}
				</Text>
			</View>
		</PressableScale>
	)
}

export default PlaylistRow
