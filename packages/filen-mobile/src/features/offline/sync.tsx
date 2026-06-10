import { useEffect, useRef } from "react"
import offline from "@/features/offline/offline"
import offlineSync from "@/features/offline/offlineSync"
import useIsAppActive from "@/hooks/useIsAppActive"
import alerts from "@/lib/alerts"

// Host component mounted in the authed app shell (root _layout, alongside
// CameraUploadSync / NotesSync / ChatsSync). Kicks the initial offline index
// refresh + sync once the shell mounts, and re-syncs on every background →
// foreground transition (offlineSync coalesces: auto passes within the
// min-interval of the last completed pass no-op). Syncs on online transitions
// are driven by the reconnect listener (src/lib/reconnect.ts).
//
// Only ever mounts when authed — the shell Fragment is gated on isAuthed — which
// preserves setup's prior `isAuthed && !options.background` guard (background
// tasks never mount the layout).
const OfflineSync = () => {
	const isAppActive = useIsAppActive()
	const wasActiveRef = useRef(isAppActive)

	useEffect(() => {
		Promise.all([offline.updateIndex(), offlineSync.sync()]).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}, [])

	useEffect(() => {
		const wasActive = wasActiveRef.current

		wasActiveRef.current = isAppActive

		// Foreground trigger: fire only on a false → true transition. The ref starts at the
		// mount-time value, so the initial render never fires here — the mount effect above
		// already runs the first sync.
		if (!wasActive && isAppActive) {
			offlineSync.sync().catch(console.error)
		}
	}, [isAppActive])

	return null
}

export default OfflineSync
