import { Fragment, useEffect, useCallback, useRef } from "react"
import { onlineManager } from "@tanstack/react-query"
import Header, { type HeaderItem } from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import { router, useLocalSearchParams, useFocusEffect } from "expo-router"
import usePlaylistsQuery from "@/features/audio/queries/usePlaylists.query"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import audio, { type PlaylistWithItems } from "@/features/audio/audio"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { randomUUID } from "expo-crypto"
import { deserialize } from "@/lib/serializer"
import events from "@/lib/events"
import usePlaylistsStore from "@/features/audio/store/usePlaylists.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import { useTranslation } from "react-i18next"
import type { MenuButton } from "@/components/ui/menu"
import type { SelectOptions } from "@/features/audio/playlistsSelect"
import PlaylistRow from "@/features/audio/components/playlistRow"

export function Playlists() {
	const { t } = useTranslation()
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

	// Hold the latest selectOptions in a ref so the cancel effect below can run on
	// unmount only. Depending on selectOptions directly would re-run the cleanup on
	// every re-render (e.g. the clearSelectedPlaylists store update on focus),
	// emitting a spurious `cancelled: true` that silently aborts the selection flow.
	const selectOptionsRef = useRef(selectOptions)

	useEffect(() => {
		selectOptionsRef.current = selectOptions
	})

	useEffect(() => {
		return () => {
			const currentSelectOptions = selectOptionsRef.current

			if (currentSelectOptions) {
				events.emit("playlistsSelect", {
					id: currentSelectOptions.id,
					cancelled: true
				})
			}
		}
	}, [])

	useFocusEffect(
		useCallback(() => {
			usePlaylistsStore.getState().clearSelectedPlaylists()

			return () => {
				usePlaylistsStore.getState().clearSelectedPlaylists()
			}
		}, [])
	)

	const allPlaylists =
		playlistsQuery.status === "success" ? [...playlistsQuery.data].sort((a, b) => b.updated - a.updated) : ([] as PlaylistWithItems[])

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
				title: selectedPlaylists.length === allPlaylists.length ? t("deselect_all") : t("select_all"),
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
				title: t("delete_selected"),
				icon: "delete",
				destructive: true,
				requiresOnline: true,
				onPress: async () => {
					await runBulk({
						items: selectedPlaylists,
						clearSelection: () => usePlaylistsStore.getState().clearSelectedPlaylists(),
						confirm: {
							title: t("delete_selected"),
							message: t("delete_selected_playlists_confirm"),
							okText: t("delete"),
							cancelText: t("cancel"),
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
				title: t("create_playlist"),
				requiresOnline: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: t("new_playlist"),
							message: t("enter_playlist_name"),
							placeholder: t("playlist_name_placeholder"),
							cancelText: t("cancel"),
							okText: t("create")
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

	const title = selectedPlaylists.length > 0 && !selectOptions ? t("selected", { count: selectedPlaylists.length }) : t("playlists")

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
							title={t("no_playlists")}
						/>
					)}
					renderItem={({ item: playlist }) => {
						return (
							<PlaylistRow
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
}

export default Playlists
