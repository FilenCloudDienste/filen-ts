import { randomUUID } from "expo-crypto"
import events, { type Events } from "@/lib/events"

// Opens a picker under a fresh session id and resolves with the first result event carrying that id.
export function awaitPickerEvent<K extends "playlistsSelect" | "contactsSelect" | "driveSelect", R>(
	event: K,
	open: (id: string) => void,
	resolveWith: (data: Events[K]) => R
): Promise<R> {
	return new Promise(resolve => {
		const id = randomUUID()

		const sub = events.subscribe(event, data => {
			if (data.id !== id) {
				return
			}

			sub.remove()

			resolve(resolveWith(data))
		})

		open(id)
	})
}
