import { Stack, useLocalSearchParams, useNavigation } from "expo-router"
import { memo, Fragment } from "react"
import { PressableScale } from "@/components/ui/pressables"
import { deserialize } from "@/lib/serializer"
import type { SelectOptions } from "@/features/audio/playlistsSelect"
import { CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useShallow } from "zustand/shallow"
import usePlaylistsStore from "@/features/audio/store/usePlaylists.store"
import Text from "@/components/ui/text"
import { cn } from "@filen/utils"
import events from "@/lib/events"
import { useTranslation } from "react-i18next"

function Toolbar() {
	const { t } = useTranslation()
	const insets = useSafeAreaInsets()
	const { selectOptions: selectOptionsSerialized } = useLocalSearchParams<{
		selectOptions?: string
	}>()
	const selectedPlaylists = usePlaylistsStore(useShallow(state => state.selectedPlaylists))
	const navigation = useNavigation()

	const selectOptions = (() => {
		if (!selectOptionsSerialized) {
			return null
		}

		try {
			const parsed = deserialize(selectOptionsSerialized) as SelectOptions

			if (!parsed.id) {
				return null
			}

			return {
				multiple: parsed.multiple,
				playlistUuidsToExclude: parsed.playlistUuidsToExclude,
				id: parsed.id
			}
		} catch {
			return null
		}
	})()

	const canSubmit = selectOptions && selectedPlaylists.length > 0 ? true : false

	if (!selectOptions) {
		return null
	}

	return (
		<PressableScale
			onPress={() => {
				if (!canSubmit) {
					return
				}

				events.emit("playlistsSelect", {
					id: selectOptions.id,
					selectedPlaylists,
					cancelled: false
				})

				navigation.getParent()?.goBack()
			}}
			className="absolute right-4"
			enabled={canSubmit}
			style={{
				bottom: insets.bottom
			}}
		>
			<CrossGlassContainerView
				className={cn("min-h-12 min-w-12 px-4 flex-row items-center justify-center", !canSubmit && "opacity-50")}
			>
				<Text className="font-bold text-blue-500">{t("select_n_playlists", { count: selectedPlaylists.length })}</Text>
			</CrossGlassContainerView>
		</PressableScale>
	)
}

const Layout = memo(() => {
	return (
		<Fragment>
			<Stack />
			<Toolbar />
		</Fragment>
	)
})

export default Layout
