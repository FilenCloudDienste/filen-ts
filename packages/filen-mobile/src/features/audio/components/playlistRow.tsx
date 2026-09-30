import { useState } from "react"
import { Platform } from "react-native"
import { router } from "@/lib/router"
import { cn } from "@filen/shared"
import View from "@/components/ui/view"
import AudioThumbnail from "@/components/ui/audioThumbnail"
import Text from "@/components/ui/text"
import { type PlaylistWithItems, useAudioQueue } from "@/features/audio/audio"
import { PressableScale } from "@/components/ui/pressables"
import { simpleDateNoTime } from "@/lib/time"
import Menu, { type MenuButton } from "@/components/ui/menu"
import {
	playlistPlaybackButtons,
	addTracksButton,
	renamePlaylistButton,
	deletePlaylistButton
} from "@/features/audio/components/playlistMenuButtons"
import usePlaylistsStore from "@/features/audio/store/usePlaylists.store"
import { useShallow } from "zustand/shallow"
import { Checkbox } from "@/components/ui/checkbox"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"
import type { SelectOptions } from "@/features/audio/playlistsSelect"

export function buildPlaylistRowButtons({ t, playlist }: { t: TFunction; playlist: PlaylistWithItems }): MenuButton[] {
	return [
		{
			id: "select",
			title: t("select"),
			icon: "select",
			onPress: () => {
				usePlaylistsStore.getState().toggleSelectedPlaylist(playlist)
			}
		},
		...playlistPlaybackButtons({ t, playlist }),
		addTracksButton({ t, playlist, id: "addTracks" }),
		renamePlaylistButton({ t, playlist, title: t("rename") }),
		deletePlaylistButton({ t, playlist, title: t("delete") })
	]
}

export function PlaylistRow({ playlist, selectOptions }: { playlist: PlaylistWithItems; selectOptions?: SelectOptions }) {
	const { t } = useTranslation()
	const { queueItem } = useAudioQueue()
	const isSelected = usePlaylistsStore(useShallow(state => state.selectedPlaylists.some(p => p.uuid === playlist.uuid)))
	const arePlaylistsSelected = usePlaylistsStore(useShallow(state => state.selectedPlaylists.length > 0))
	const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false)

	const isCurrent = !!queueItem && playlist.uuid === queueItem.playlistUuid
	const disabled = selectOptions?.playlistUuidsToExclude?.includes(playlist.uuid) ?? false

	// The context menu (long-press) is only available in normal browse mode. In
	// picker mode (`selectOptions`) or bulk-selection mode (`arePlaylistsSelected`)
	// the Menu is disabled so the row renders bare and tap toggles selection.
	const menuDisabled = !!selectOptions || arePlaylistsSelected

	const onPress = () => {
		if (disabled) {
			return
		}

		if (selectOptions) {
			usePlaylistsStore.getState().toggleSelectedPlaylist(playlist)

			return
		}

		// In bulk-selection mode (selection started via the context menu "Select"
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
		<Menu
			type="context"
			disabled={menuDisabled}
			previewBackground={true}
			onOpenMenu={() => setIsMenuOpen(true)}
			onCloseMenu={() => setIsMenuOpen(false)}
			buttons={buildPlaylistRowButtons({ t, playlist })}
		>
			<PressableScale
				className={cn(
					"flex-row items-center px-4 gap-3",
					disabled && "opacity-50 pointer-events-none",
					isSelected && !selectOptions
						? "bg-background-tertiary"
						: Platform.OS === "android" && isMenuOpen
							? "bg-background-secondary"
							: "bg-transparent"
				)}
				onPress={onPress}
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
				<AudioThumbnail
					active={isCurrent}
					className={isSelected ? "bg-background-secondary" : undefined}
				/>
				<View className="flex-col bg-transparent flex-1 border-b border-separator py-2.5">
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
		</Menu>
	)
}

export default PlaylistRow
