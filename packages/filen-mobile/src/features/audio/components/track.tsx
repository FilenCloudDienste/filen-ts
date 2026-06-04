import { useResolveClassNames } from "uniwind"
import { run, formatBytes, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import audio, { type PlaylistWithItems, useAudioQueue } from "@/features/audio/audio"
import { PressableScale } from "@/components/ui/pressables"
import { driveItemDisplayName } from "@/lib/decryption"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import useAudioMetadataQuery from "@/features/audio/queries/useAudioMetadata.query"
import Image from "@/components/ui/image"
import { useReorderableDrag } from "react-native-reorderable-list"
import { selectPlaylists } from "@/features/audio/playlistsSelect"
import { actionSheet, type ShowActionSheetOptions } from "@/providers/actionSheet.provider"
import usePlaylistTracksStore from "@/features/audio/store/usePlaylistTracks.store"
import { useShallow } from "zustand/shallow"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"

type TrackType = PlaylistWithItems["files"][number]

function selectButton({ t, track }: { t: TFunction; track: TrackType }): ShowActionSheetOptions["buttons"][number] {
	return {
		title: t("select"),
		onPress: () => {
			usePlaylistTracksStore.getState().toggleSelectedTrack(track)
		}
	}
}

function removeFromPlaylistButton({
	t,
	track,
	playlist
}: {
	t: TFunction
	track: TrackType
	playlist: PlaylistWithItems
}): ShowActionSheetOptions["buttons"][number] {
	return {
		title: t("remove_from_playlist"),
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
	}
}

function buildUndecryptableTrackButtons({
	t,
	track,
	playlist
}: {
	t: TFunction
	track: TrackType
	playlist: PlaylistWithItems
}): ShowActionSheetOptions["buttons"] {
	return [
		selectButton({ t, track }),
		removeFromPlaylistButton({ t, track, playlist }),
		{
			title: t("close"),
			cancel: true
		}
	]
}

function buildTrackButtons({
	t,
	track,
	playlist
}: {
	t: TFunction
	track: TrackType
	playlist: PlaylistWithItems
}): ShowActionSheetOptions["buttons"] {
	return [
		selectButton({ t, track }),
		{
			title: t("play"),
			onPress: async () => {
				const result = await runWithLoading(async () => {
					const index = playlist.files.findIndex(f => f.uuid === track.uuid)

					const { droppedUndecryptable } = await audio.replaceQueue({
						items: playlist.files.map(file => ({
							item: file.item,
							playlistUuid: playlist.uuid
						})),
						startingPosition: index >= 0 ? index : 0
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

					const added = await audio.addToQueue({
						item: {
							playlistUuid: playlist.uuid,
							item: track.item
						}
					})

					if (!added) {
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
		},
		{
			title: t("add_to_playlist"),
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
		removeFromPlaylistButton({ t, track, playlist }),
		{
			title: t("close"),
			cancel: true
		}
	]
}

export function Track({ track, playlist }: { track: TrackType; playlist: PlaylistWithItems }) {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const drag = useReorderableDrag()
	const { queueItem } = useAudioQueue()
	const isSelected = usePlaylistTracksStore(useShallow(state => state.selectedTracks.some(t => t.uuid === track.uuid)))
	const areTracksSelected = usePlaylistTracksStore(useShallow(state => state.selectedTracks.length > 0))

	const isCurrent = !!queueItem && track.uuid === queueItem.item.data.uuid

	const audioMetadataQuery = useAudioMetadataQuery({
		type: "drive",
		data: {
			uuid: track.item.data.uuid
		}
	})

	const undecryptable = track.item.data.undecryptable
	const displayName = driveItemDisplayName(track.item)

	return (
		<PressableScale
			className={cn("bg-transparent flex-row items-center px-4 gap-3", isSelected && "bg-background-tertiary")}
			onLongPress={areTracksSelected ? undefined : drag}
			onPress={() => {
				if (areTracksSelected) {
					usePlaylistTracksStore.getState().toggleSelectedTrack(track)

					return
				}

				if (undecryptable) {
					actionSheet.show({
						buttons: buildUndecryptableTrackButtons({ t, track, playlist })
					})

					return
				}

				actionSheet.show({
					buttons: buildTrackButtons({ t, track, playlist })
				})
			}}
		>
			{areTracksSelected && (
				<AnimatedView
					className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0"
					entering={FadeIn}
					exiting={FadeOut}
				>
					<Checkbox value={isSelected} />
				</AnimatedView>
			)}
			{audioMetadataQuery.status === "success" && audioMetadataQuery.data?.pictureUri ? (
				<Image
					className={cn(
						"size-10 rounded-lg bg-background-tertiary",
						isCurrent ? "border border-blue-500" : "border border-transparent"
					)}
					source={{
						uri: audioMetadataQuery.data.pictureUri
					}}
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
					{undecryptable
						? displayName
						: audioMetadataQuery.status === "success" && audioMetadataQuery.data?.title
							? audioMetadataQuery.data.title
							: track.name}
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
}

export default Track
