import { router } from "expo-router"
import { randomUUID } from "expo-crypto"
import events from "@/lib/events"
import { serialize } from "@/lib/serializer"
import type { PlaylistWithItems } from "@/features/audio/audio"

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
