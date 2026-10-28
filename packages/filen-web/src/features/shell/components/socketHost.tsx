import { useEffect } from "react"
import { socketBridge } from "@/lib/sdk/socket"
import { registerNoteSocketHandlers } from "@/features/notes/lib/socketHandlers"
import { registerChatSocketHandlers } from "@/features/chats/lib/socketHandlers"
import { registerDriveSocketHandlers } from "@/features/drive/lib/socketHandlers"
import { registerContactSocketHandlers } from "@/features/contacts/lib/socketHandlers"
import { registerGeneralSocketHandlers } from "@/features/shell/lib/generalSocketHandlers"
import { registerPlaylistSocketHandlers } from "@/features/audio/lib/socketHandlers"
import { registerDotFilenSocketHandlers } from "@/lib/dotFilen"
import { registerLibraryConfigSocketHandlers } from "@/features/videos/lib/library"
import { registerWatchStateSocketHandlers } from "@/features/videos/lib/watchState"
import { registerUserDictionarySocketHandlers } from "@/features/spellcheck/lib/userDictionary"
import { registerOfficeSettingsSocketHandlers } from "@/features/office/lib/officeSettings"
import { registerPhotosLibrarySocketHandlers } from "@/features/photos/lib/library"
import { registerDirectoryRootSocketHandlers } from "@/lib/directoryRoots"

const REGISTRARS: readonly (() => () => void)[] = [
	registerNoteSocketHandlers,
	registerChatSocketHandlers,
	registerDriveSocketHandlers,
	registerContactSocketHandlers,
	registerGeneralSocketHandlers,
	registerPlaylistSocketHandlers,
	registerDotFilenSocketHandlers,
	registerLibraryConfigSocketHandlers,
	registerWatchStateSocketHandlers,
	registerUserDictionarySocketHandlers,
	registerOfficeSettingsSocketHandlers,
	registerPhotosLibrarySocketHandlers,
	registerDirectoryRootSocketHandlers
]

// The realtime socket driver, mounted ONCE in the authed shell (appShell) — NOT a route, because
// realtime updates must land while the user is anywhere in the app. On mount it registers every domain's
// handlers (note + chat + drive + contact + general + playlists + `.filen` + Videos library + watch state +
// spelling dictionary + document settings + Photos library + root directory chains) and starts the single
// subscription; the bridge outlives route navigation. Teardown is on LOGOUT (performLogout stops the bridge before the local wipe,
// mirroring notesSync.cancel), so the unmount cleanup only unregisters the handlers — the subscription
// itself is not stopped here (a StrictMode remount must not tear the live socket down). Renders nothing.
export function SocketHost(): null {
	useEffect(() => {
		const unregisters = REGISTRARS.map(register => register())

		void socketBridge.start()

		return () => {
			for (const unregister of unregisters) {
				unregister()
			}
		}
	}, [])

	return null
}
