import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import offline from "@/features/offline/offline"
import offlineSync from "@/features/offline/offlineSync"
import useIsAppActive from "@/hooks/useIsAppActive"
import alerts from "@/lib/alerts"

// Host component mounted in the authed app shell (root _layout, alongside
// CameraUploadSync / NotesSync / ChatsSync). Kicks the initial offline index
// refresh + sync once the shell mounts IN FOREGROUND, and re-syncs on every
// background → foreground transition (offlineSync coalesces: auto passes within
// the min-interval of the last completed pass no-op). Syncs on online transitions
// are driven by the reconnect listener (src/lib/reconnect.ts).
//
// Only ever mounts when authed — the shell Fragment is gated on isAuthed. NOTE:
// an iOS cold background launch (BGProcessingTask) DOES mount the layout with
// AppState "background" — the mount effect below must not fire an unbudgeted
// sync there (it would win offlineSync's inFlight coalescing over the budgeted
// background pass). The foreground-transition effect covers the deferred first
// sync; offlineSync.runPass ends with updateIndex, so the index refresh is
// covered there too.
const OfflineSync = () => {
	const isAppActive = useIsAppActive()
	const wasActiveRef = useRef(isAppActive)

	useEffect(() => {
		if (AppState.currentState !== "active") {
			return
		}

		Promise.all([offline.updateIndex(), offlineSync.sync()]).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}, [])

	useEffect(() => {
		const wasActive = wasActiveRef.current

		wasActiveRef.current = isAppActive

		// Foreground trigger: fire only on a false → true transition. The ref starts at the
		// mount-time value, so the initial render never fires here. Foreground mounts get
		// their first sync from the mount effect above; background mounts (skipped there)
		// get it here on the first real "active" transition.
		if (!wasActive && isAppActive) {
			offlineSync.sync().catch(console.error)
		}
	}, [isAppActive])

	return null
}

export default OfflineSync
