import useDismissStack from "@/hooks/useDismissStack"
import { usePlaylistSelectOptions } from "@/features/audio/playlistsSelect"
import { useShallow } from "zustand/shallow"
import usePlaylistsStore from "@/features/audio/store/usePlaylists.store"
import events from "@/lib/events"
import { useTranslation } from "react-i18next"
import FloatingActionPill from "@/components/ui/floatingActionPill"

const PlaylistsSelectToolbar = () => {
	const { t } = useTranslation()
	const selectId = usePlaylistSelectOptions()?.id ?? null
	const selectedPlaylists = usePlaylistsStore(useShallow(state => state.selectedPlaylists))
	const dismiss = useDismissStack()

	if (!selectId) {
		return null
	}

	const canSubmit = selectedPlaylists.length > 0

	return (
		<FloatingActionPill
			label={t("select_n_playlists", { count: selectedPlaylists.length })}
			enabled={canSubmit}
			onPress={() => {
				if (!canSubmit) {
					return
				}

				events.emit("playlistsSelect", {
					id: selectId,
					selectedPlaylists,
					cancelled: false
				})

				dismiss()
			}}
		/>
	)
}

export default PlaylistsSelectToolbar
