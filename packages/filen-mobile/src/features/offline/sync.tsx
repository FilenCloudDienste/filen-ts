import { useEffect } from "react"
import offline from "@/features/offline/offline"
import alerts from "@/lib/alerts"

// Host component mounted in the authed app shell (root _layout, alongside
// CameraUploadSync / NotesSync / ChatsSync). Kicks the initial offline index
// refresh + sync once the shell mounts. Moved here out of src/lib/setup.ts so
// setup stays focused on bringing the app up; subsequent syncs on online
// transitions are driven by the reconnect listener (src/lib/reconnect.ts).
//
// Only ever mounts when authed — the shell Fragment is gated on isAuthed — which
// preserves setup's prior `isAuthed && !options.background` guard (background
// tasks never mount the layout).
const OfflineSync = () => {
	useEffect(() => {
		Promise.all([offline.updateIndex(), offline.sync()]).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}, [])

	return null
}

export default OfflineSync
