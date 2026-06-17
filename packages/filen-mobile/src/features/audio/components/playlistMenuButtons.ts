import { router } from "expo-router"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import audio, { type PlaylistWithItems } from "@/features/audio/audio"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { selectDriveItems } from "@/features/drive/screens/driveSelect"
import { selectPlaylists } from "@/features/audio/playlistsSelect"
import usePlaylistTracksStore, { type PlaylistTrack } from "@/features/audio/store/usePlaylistTracks.store"
import { runBulk } from "@/lib/bulkOps"
import type { MenuButton } from "@/components/ui/menu"
import { type TFunction } from "i18next"
import logger from "@/lib/logger"

/**
 * Shared "add tracks to playlist" flow: opens the drive item picker filtered to audio files,
 * pre-excluding the playlist's current items from the selectable set, then persists the additions.
 * Actual deduplication against existing playlist items is handled inside `audio.addFilesToPlaylist`.
 * Called from both the playlist header menu and the empty-state CTA.
 */
export async function addTracksToPlaylistFlow({ playlist }: { playlist: PlaylistWithItems }): Promise<void> {
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
		logger.error("audio", "drive item selection failed in add-tracks flow", { playlistUuid: playlist.uuid, error: selectDriveItemsResult.error instanceof Error ? selectDriveItemsResult.error.message : String(selectDriveItemsResult.error) })
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
		logger.error("audio", "addFilesToPlaylist failed", { playlistUuid: playlist.uuid, error: result.error instanceof Error ? result.error.message : String(result.error) })
		alerts.error(result.error)
	}
}

/**
 * Right-menu buttons shown while tracks are selected (bulk actions).
 */
export function buildSelectionMenuButtons({
	t,
	playlist,
	selectedTracks,
	visibleTracks
}: {
	t: TFunction
	playlist: PlaylistWithItems
	selectedTracks: PlaylistTrack[]
	visibleTracks?: PlaylistTrack[]
}): MenuButton[] {
	const buttons: MenuButton[] = []

	// Select-all operates on the currently visible (search-filtered) set, falling back to
	// the full playlist when no filter is applied — so "Select all" never reaches hidden tracks.
	const selectableTracks = visibleTracks ?? playlist.files
	const allVisibleSelected =
		selectableTracks.length > 0 && selectableTracks.every(track => selectedTracks.some(st => st.uuid === track.uuid))

	buttons.push({
		id: "selectAllTracks",
		title: allVisibleSelected ? t("deselect_all") : t("select_all"),
		icon: "select",
		onPress: () => {
			if (selectableTracks.length === 0) {
				return
			}

			if (allVisibleSelected) {
				usePlaylistTracksStore.getState().clearSelectedTracks()

				return
			}

			usePlaylistTracksStore.getState().selectAllTracks(selectableTracks)
		}
	})

	buttons.push({
		id: "bulkAddToQueue",
		title: t("add_to_queue"),
		icon: "queue",
		onPress: async () => {
			const playlistUuid = playlist.uuid
			const queueWasEmpty = audio.getQueue().length === 0

			let droppedUndecryptable = false

			await runBulk({
				items: selectedTracks,
				clearSelection: () => usePlaylistTracksStore.getState().clearSelectedTracks(),
				op: async track => {
					const added = await audio.addToQueue({
						item: {
							playlistUuid,
							item: track.item
						}
					})

					if (!added) {
						droppedUndecryptable = true
					}
				}
			})

			if (droppedUndecryptable) {
				alerts.normal(t("cannot_decrypt_toast"))
			}

			if (queueWasEmpty && audio.getQueue().length > 0) {
				await audio.play()
			}
		}
	})

	// Add to another playlist (the picker excludes the current playlist).
	// For each target playlist, append all selected tracks (deduped by uuid)
	// and save once per target — that's the per-item op of runBulk, where
	// "item" is the target playlist, not the source track.
	buttons.push({
		id: "bulkAddToPlaylist",
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
				logger.error("audio", "select playlists failed in bulk-add flow", { playlistUuid: playlist.uuid, error: selectResult.error instanceof Error ? selectResult.error.message : String(selectResult.error) })
				alerts.error(selectResult.error)

				return
			}

			if (selectResult.data.cancelled || selectResult.data.selectedPlaylists.length === 0) {
				return
			}

			const targets = selectResult.data.selectedPlaylists

			await runBulk({
				items: targets,
				clearSelection: () => usePlaylistTracksStore.getState().clearSelectedTracks(),
				op: async target => {
					// Re-read selected tracks from the live store so a tap that
					// arrives between picker close and op execution still gets
					// the correct set.
					const liveTracks = usePlaylistTracksStore.getState().selectedTracks
					const existing = new Set(target.files.map(f => f.uuid))
					const toAppend = liveTracks
						.filter(t => !existing.has(t.uuid))
						.map(t => ({
							uuid: t.uuid,
							name: t.name,
							mime: t.mime,
							size: t.size,
							bucket: t.bucket,
							key: t.key,
							version: t.version,
							chunks: t.chunks,
							region: t.region,
							playlist: target.uuid,
							item: t.item
						}))

					if (toAppend.length === 0) {
						return
					}

					await audio.savePlaylist({
						playlist: {
							...target,
							files: [...target.files, ...toAppend],
							updated: Date.now()
						}
					})
				}
			})
		}
	})

	buttons.push({
		id: "bulkRemoveTracks",
		title: t("remove_from_playlist"),
		icon: "delete",
		destructive: true,
		requiresOnline: true,
		onPress: async () => {
			const currentPlaylist = playlist

			await runBulk({
				items: [currentPlaylist],
				clearSelection: () => usePlaylistTracksStore.getState().clearSelectedTracks(),
				confirm: {
					title: t("remove_from_playlist"),
					message: t("are_you_sure_remove_selected_from_playlist"),
					okText: t("remove"),
					cancelText: t("cancel"),
					destructive: true
				},
				op: async p => {
					// Re-read selection from the live store rather than the
					// render-time closure — between menu open and confirm,
					// the user can still toggle tracks.
					const liveSelectedUuids = new Set(usePlaylistTracksStore.getState().selectedTracks.map(t => t.uuid))

					await audio.savePlaylist({
						playlist: {
							...p,
							files: p.files.filter(f => !liveSelectedUuids.has(f.uuid)),
							updated: Date.now()
						}
					})
				}
			})
		}
	})

	return buttons
}

/**
 * Right-menu buttons shown in normal mode (play / add to queue / rename / add tracks / delete).
 */
export function buildPlaylistMenuButtons({ t, playlist }: { t: TFunction; playlist: PlaylistWithItems }): MenuButton[] {
	return [
		...(playlist.files.length > 0
			? ([
					{
						id: "play",
						title: t("play"),
						icon: "play",
						onPress: async () => {
							const result = await runWithLoading(async () => {
								// Plain play is deterministically in-order: clear any inherited shuffle
								// mode so a previous "Shuffle play" doesn't bleed into this playback.
								await audio.setShuffleEnabled(false)
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
								logger.error("audio", "play playlist failed", { playlistUuid: playlist.uuid, error: result.error instanceof Error ? result.error.message : String(result.error) })
								alerts.error(result.error)

								return
							}
						}
					},
					{
						id: "shufflePlay",
						title: t("shuffle_play"),
						icon: "listBullet",
						onPress: async () => {
							const result = await runWithLoading(async () => {
								await audio.setShuffleEnabled(true)

								// Start on a random track so "Shuffle play" actually begins shuffled —
								// replaceQueue pins startingPosition first in the shuffle order and play()
								// loads it; with position 0 the first track would always be track #1.
								const { droppedUndecryptable } = await audio.replaceQueue({
									items: playlist.files.map(file => ({
										item: file.item,
										playlistUuid: playlist.uuid
									})),
									startingPosition: Math.floor(Math.random() * playlist.files.length)
								})

								if (droppedUndecryptable) {
									alerts.normal(t("cannot_decrypt_toast"))
								}

								await audio.play()
							})

							if (!result.success) {
								logger.error("audio", "shuffle play playlist failed", { playlistUuid: playlist.uuid, error: result.error instanceof Error ? result.error.message : String(result.error) })
								alerts.error(result.error)

								return
							}
						}
					},
					{
						id: "addToQueue",
						title: t("add_to_queue"),
						icon: "queue",
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
								logger.error("audio", "add playlist to queue failed", { playlistUuid: playlist.uuid, error: result.error instanceof Error ? result.error.message : String(result.error) })
								alerts.error(result.error)

								return
							}
						}
					}
				] satisfies MenuButton[])
			: []),
		{
			id: "rename",
			icon: "edit",
			title: t("rename_playlist"),
			requiresOnline: true,
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
					logger.error("audio", "rename playlist prompt failed", { playlistUuid: playlist.uuid, error: promptResult.error instanceof Error ? promptResult.error.message : String(promptResult.error) })
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
					logger.error("audio", "rename playlist failed", { playlistUuid: playlist.uuid, error: result.error instanceof Error ? result.error.message : String(result.error) })
					alerts.error(result.error)

					return
				}
			}
		},
		{
			id: "add",
			icon: "plus",
			title: t("add_tracks"),
			requiresOnline: true,
			onPress: async () => {
				await addTracksToPlaylistFlow({ playlist })
			}
		},
		{
			id: "delete",
			icon: "delete",
			title: t("delete_playlist"),
			destructive: true,
			requiresOnline: true,
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
					logger.error("audio", "delete playlist prompt failed", { playlistUuid: playlist.uuid, error: promptResult.error instanceof Error ? promptResult.error.message : String(promptResult.error) })
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
					logger.error("audio", "delete playlist failed", { playlistUuid: playlist.uuid, error: result.error instanceof Error ? result.error.message : String(result.error) })
					alerts.error(result.error)

					return
				}

				router.back()
			}
		}
	]
}
