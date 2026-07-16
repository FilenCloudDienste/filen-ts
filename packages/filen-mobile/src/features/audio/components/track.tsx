import { run, formatBytes, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import audio, { type PlaylistWithItems, useIsCurrentTrack } from "@/features/audio/audio"
import { PressableScale } from "@/components/ui/pressables"
import { driveItemDisplayName } from "@/lib/decryption"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import useAudioMetadataQuery from "@/features/audio/queries/useAudioMetadata.query"
import AudioThumbnail from "@/components/ui/audioThumbnail"
import { useReorderableDrag } from "react-native-reorderable-list"
import { selectPlaylists } from "@/features/audio/playlistsSelect"
import Menu, { type MenuButton } from "@/components/ui/menu"
import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
import usePlaylistTracksStore from "@/features/audio/store/usePlaylistTracks.store"
import { useShallow } from "zustand/shallow"
import { Checkbox } from "@/components/ui/checkbox"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"
import logger from "@/lib/logger"

type TrackType = PlaylistWithItems["files"][number]

// Replaces the queue with the track's playlist (starting at the track) and starts playback.
// Shared by the row tap (primary action) and the trailing dropdown's "play" button.
async function playTrack({ t, track, playlist }: { t: TFunction; track: TrackType; playlist: PlaylistWithItems }): Promise<void> {
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
		logger.error("audio", "playTrack failed", { uuid: track.uuid, error: result.error })
		alerts.error(result.error)

		return
	}
}

function selectButton({ t, track }: { t: TFunction; track: TrackType }): MenuButton {
	return {
		id: "select",
		title: t("select"),
		icon: "select",
		onPress: () => {
			usePlaylistTracksStore.getState().toggleSelectedTrack(track)
		}
	}
}

function removeFromPlaylistButton({ t, track, playlist }: { t: TFunction; track: TrackType; playlist: PlaylistWithItems }): MenuButton {
	return {
		id: "removeFromPlaylist",
		title: t("remove_from_playlist"),
		icon: "delete",
		destructive: true,
		requiresOnline: true,
		onPress: async () => {
			const result = await runWithLoading(async () => {
				await audio.removeFilesFromPlaylist({
					playlist,
					uuids: [track.uuid]
				})
			})

			if (!result.success) {
				logger.error("audio", "remove from playlist failed", { uuid: track.uuid, error: result.error })
				alerts.error(result.error)

				return
			}
		}
	}
}

export function buildUndecryptableTrackButtons({
	t,
	track,
	playlist
}: {
	t: TFunction
	track: TrackType
	playlist: PlaylistWithItems
}): MenuButton[] {
	return [selectButton({ t, track }), removeFromPlaylistButton({ t, track, playlist })]
}

export function buildTrackButtons({ t, track, playlist }: { t: TFunction; track: TrackType; playlist: PlaylistWithItems }): MenuButton[] {
	return [
		{
			id: "play",
			title: t("play"),
			icon: "play",
			onPress: async () => {
				await playTrack({ t, track, playlist })
			}
		},
		{
			id: "addToQueue",
			title: t("add_to_queue"),
			icon: "queue",
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
					logger.error("audio", "add to queue failed", { uuid: track.uuid, error: result.error })
					alerts.error(result.error)

					return
				}
			}
		},
		{
			id: "addToPlaylist",
			title: t("add_to_playlist"),
			icon: "plus",
			requiresOnline: true,
			onPress: async () => {
				const selectResult = await run(async () => {
					return await selectPlaylists({
						multiple: true,
						playlistUuidsToExclude: [playlist.uuid]
					})
				})

				if (!selectResult.success) {
					logger.error("audio", "select playlists failed", { uuid: track.uuid, error: selectResult.error })
					alerts.error(selectResult.error)

					return
				}

				if (selectResult.data.cancelled || selectResult.data.selectedPlaylists.length === 0) {
					return
				}

				const selectedPlaylists = selectResult.data.selectedPlaylists

				const result = await runWithLoading(async () => {
					await Promise.all(
						// addTracksToPlaylist dedups against the FRESHEST copy and re-stamps the target uuid,
						// so the stale-snapshot existence check is no longer needed here.
						selectedPlaylists.map(selectedPlaylist =>
							audio.addTracksToPlaylist({
								playlist: selectedPlaylist,
								tracks: [
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
							})
						)
					)
				})

				if (!result.success) {
					logger.error("audio", "add to playlist failed", { uuid: track.uuid, error: result.error })
					alerts.error(result.error)

					return
				}
			}
		},
		selectButton({ t, track }),
		removeFromPlaylistButton({ t, track, playlist })
	]
}

export function Track({ track, playlist, reorderDisabled }: { track: TrackType; playlist: PlaylistWithItems; reorderDisabled?: boolean }) {
	const { t } = useTranslation()
	const drag = useReorderableDrag()
	const isCurrent = useIsCurrentTrack(track.item.data.uuid)
	const { isSelected, areTracksSelected } = usePlaylistTracksStore(
		useShallow(state => ({
			isSelected: state.selectedTracks.some(st => st.uuid === track.uuid),
			areTracksSelected: state.selectedTracks.length > 0
		}))
	)

	const audioMetadataQuery = useAudioMetadataQuery({
		type: "drive",
		data: {
			uuid: track.item.data.uuid,
			// By-value so a cross-directory search hit resolves its metadata.
			item: track.item
		}
	})

	const undecryptable = track.item.data.undecryptable
	const displayName = driveItemDisplayName(track.item)

	// ListRow-style trailing-menu model: the tap target wraps the leading + body only, the trailing
	// "⋯" dropdown sits OUTSIDE the PressableScale as a sibling. This is load-bearing on BOTH
	// platforms: on iOS a native menu trigger also responds to long-press (fights drag-reorder if
	// it wraps the row), and on Android the trigger is a native MenuView that must receive the tap
	// itself — nested inside a gesture-handler pressable the parent claims the touch and the menu
	// never opens. Row tap is the primary action (play); long-press stays a pure drag passthrough;
	// the trailing trigger is hidden in selection mode where the row tap toggles selection instead.
	return (
		<View className={cn("bg-transparent flex-row items-center px-4", isSelected && "bg-background-tertiary")}>
			<PressableScale
				className="bg-transparent flex-row items-center gap-3 flex-1"
				onLongPress={areTracksSelected || reorderDisabled ? undefined : drag}
				onPress={() => {
					if (areTracksSelected) {
						usePlaylistTracksStore.getState().toggleSelectedTrack(track)

						return
					}

					if (undecryptable) {
						alerts.normal(t("cannot_decrypt_toast"))

						return
					}

					playTrack({ t, track, playlist }).catch(e => logger.error("audio", "playTrack failed from row tap", { uuid: track.uuid, error: e }))
				}}
			>
				{areTracksSelected && (
					<View className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0">
						<Checkbox value={isSelected} />
					</View>
				)}
				<AudioThumbnail
					pictureUri={audioMetadataQuery.status === "success" ? audioMetadataQuery.data?.pictureUri : null}
					active={isCurrent}
					recyclingKey={`toolbar-audio-picture-${track.item.data.uuid}`}
					className={isSelected ? "bg-background-secondary" : undefined}
				/>
				<View className="flex-col bg-transparent flex-1 border-b border-separator py-2.5">
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
			{!areTracksSelected && (
				<View className="self-stretch shrink-0 flex-row items-center bg-transparent border-b border-separator pl-3">
					<Menu
						type="dropdown"
						isAnchoredToRight={true}
						buttons={
							undecryptable
								? buildUndecryptableTrackButtons({ t, track, playlist })
								: buildTrackButtons({ t, track, playlist })
						}
					>
						<EllipsisMenuTrigger />
					</Menu>
				</View>
			)}
		</View>
	)
}

export default Track
