import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import logger from "@/lib/logger"
import notesOffline from "@/features/notes/notesOffline"
import useIsAppActive from "@/hooks/useIsAppActive"

/**
 * Host component mounted in the authed app shell, alongside NotesSync / OfflineSync. Keeps the
 * bodies of notes marked available offline current.
 *
 * Triggers here are the foreground ones: the shell mounting in foreground, and every
 * background → foreground transition. Reconnects are driven by lib/reconnect, and headless runs by
 * the background task — `notesOffline.sync()` is internally serialized, so overlapping triggers
 * collapse instead of racing.
 *
 * Mirrors OfflineSync's mount guard: an iOS cold background launch (BGProcessingTask) DOES mount the
 * layout with AppState "background", and firing an unbudgeted pass there would win the mutex against
 * the budgeted pass the task itself runs. The foreground-transition effect covers that deferred first
 * pass.
 *
 * Note that `sync()` loads the ledger before it checks connectivity, so an offline launch still ends
 * up with the marked-note badges populated.
 */
const NotesOfflineSync = () => {
	const isAppActive = useIsAppActive()
	const wasActiveRef = useRef(isAppActive)

	useEffect(() => {
		// UNCONDITIONAL, ahead of the AppState gate. The ledger drives two things that must be right
		// before any pass runs: the row badges, and `hasOfflineNotes` in features/cameraUpload/sync,
		// which ORs into whether the OS background task stays registered. In a headless cold launch the
		// gate below returns early, so without this the projection is still empty when that debounced
		// registration fires — and a notes-only user's background task DEREGISTERS ITSELF, leaving the
		// one trigger that reaches them dead until they next open the app. Local kv read, no network.
		notesOffline.load().catch(err => {
			logger.error("notes-offline", "Ledger load failed on mount", { error: err })
		})

		if (AppState.currentState !== "active") {
			return
		}

		notesOffline.sync().catch(err => {
			logger.error("notes-offline", "Initial sync failed on mount", { error: err })
		})
	}, [])

	useEffect(() => {
		const wasActive = wasActiveRef.current

		wasActiveRef.current = isAppActive

		// Fire only on a false → true transition. The ref starts at the mount-time value, so the
		// initial render never fires here; foreground mounts get their first pass from the mount
		// effect above, background mounts (skipped there) from the first real "active" transition.
		if (!wasActive && isAppActive) {
			notesOffline.sync().catch(err => {
				logger.warn("notes-offline", "Foreground transition sync failed", { error: err })
			})
		}
	}, [isAppActive])

	return null
}

export default NotesOfflineSync
