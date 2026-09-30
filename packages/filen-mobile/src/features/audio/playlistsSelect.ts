import { useLocalSearchParams } from "expo-router"
import { router } from "@/lib/router"
import { awaitPickerEvent } from "@/lib/awaitPickerEvent"
import { serialize, deserializeRouteParam } from "@/lib/serializer"
import type { PlaylistWithItems } from "@/features/audio/audio"

export type SelectOptions = {
	id: string
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
	return awaitPickerEvent(
		"playlistsSelect",
		id => {
			router.push({
				pathname: "/selectPlaylists",
				params: {
					selectOptions: serialize({
						...options,
						id
					} satisfies SelectOptions)
				}
			})
		},
		data =>
			data.cancelled || data.selectedPlaylists.length === 0
				? {
						cancelled: true
					}
				: {
						cancelled: false,
						selectedPlaylists: data.selectedPlaylists
					}
	)
}

// Same shape as contacts' useSelectOptions: string read up front, no try/catch, so it stays compiled.
export function usePlaylistSelectOptions(): SelectOptions | null {
	const { selectOptions: param } = useLocalSearchParams<{
		selectOptions?: string
	}>()
	const parsed = deserializeRouteParam<SelectOptions>(param)

	if (!parsed || !parsed.id) {
		return null
	}

	return {
		id: parsed.id,
		playlistUuidsToExclude: parsed.playlistUuidsToExclude
	}
}
