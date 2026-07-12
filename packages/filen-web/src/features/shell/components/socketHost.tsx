import { useEffect } from "react"
import { socketBridge } from "@/lib/sdk/socket"
import { registerNoteSocketHandlers } from "@/features/notes/lib/socketHandlers"
import { registerChatSocketHandlers } from "@/features/chats/lib/socketHandlers"
import { registerDriveSocketHandlers } from "@/features/drive/lib/socketHandlers"
import { registerContactSocketHandlers } from "@/features/contacts/lib/socketHandlers"
import { registerGeneralSocketHandlers } from "@/features/shell/lib/generalSocketHandlers"

// The realtime socket driver, mounted ONCE in the authed shell (appShell) — NOT a route, because
// realtime updates must land while the user is anywhere in the app. On mount it registers every domain's
// handlers (note + chat + drive + contact + general) and starts the single subscription; the bridge
// outlives route navigation. Teardown is on LOGOUT (performLogout stops the bridge before the local wipe,
// mirroring notesSync.cancel), so the unmount cleanup only unregisters the handlers — the subscription
// itself is not stopped here (a StrictMode remount must not tear the live socket down). Renders nothing.
export function SocketHost(): null {
	useEffect(() => {
		const unregisterNotes = registerNoteSocketHandlers()
		const unregisterChats = registerChatSocketHandlers()
		const unregisterDrive = registerDriveSocketHandlers()
		const unregisterContacts = registerContactSocketHandlers()
		const unregisterGeneral = registerGeneralSocketHandlers()

		void socketBridge.start()

		return () => {
			unregisterNotes()
			unregisterChats()
			unregisterDrive()
			unregisterContacts()
			unregisterGeneral()
		}
	}, [])

	return null
}

export default SocketHost
