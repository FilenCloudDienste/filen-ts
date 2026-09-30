import { useEffect } from "react"
import logger from "@/lib/logger"
import notesOffline from "@/features/notes/notesOffline"
import useForegroundTrigger from "@/hooks/useForegroundTrigger"

function onMountActive(): void {
	notesOffline.sync().catch(err => {
		logger.error("notes-offline", "Initial sync failed on mount", { error: err })
	})
}

function onForeground(): void {
	notesOffline.sync().catch(err => {
		logger.warn("notes-offline", "Foreground transition sync failed", { error: err })
	})
}

/**
 * Host component mounted in the authed app shell, alongside NotesSync / OfflineSync. Keeps the
 * bodies of notes marked available offline current.
 *
 * Triggers here are the foreground ones (see useForegroundTrigger). Reconnects are driven by
 * lib/reconnect, and headless runs by the background task — `notesOffline.sync()` is internally
 * serialized, so overlapping triggers collapse instead of racing.
 *
 * Note that `sync()` loads the ledger before it checks connectivity, so an offline launch still ends
 * up with the marked-note badges populated.
 */
const NotesOfflineSync = () => {
	useEffect(() => {
		// UNCONDITIONAL, and declared before the foreground trigger so it runs first. The ledger drives
		// two things that must be right before any pass runs: the row badges, and `hasOfflineNotes` in
		// features/cameraUpload/sync, which ORs into whether the OS background task stays registered. In a
		// headless cold launch the trigger skips its mount pass, so without this the projection is still
		// empty when that debounced registration fires — and a notes-only user's background task
		// DEREGISTERS ITSELF, leaving the one trigger that reaches them dead until they next open the
		// app. Local kv read, no network.
		notesOffline.load().catch(err => {
			logger.error("notes-offline", "Ledger load failed on mount", { error: err })
		})
	}, [])

	useForegroundTrigger(onMountActive, onForeground)

	return null
}

export default NotesOfflineSync
