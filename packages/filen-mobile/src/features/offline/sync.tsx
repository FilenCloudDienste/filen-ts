import logger from "@/lib/logger"
import offline from "@/features/offline/offline"
import offlineSync from "@/features/offline/offlineSync"
import useForegroundTrigger from "@/hooks/useForegroundTrigger"
import alerts from "@/lib/alerts"

function onMountActive(): void {
	Promise.all([offline.updateIndex(), offlineSync.sync()]).catch(err => {
		logger.error("offline-sync", "Initial index refresh or sync failed on mount", { error: err })
		alerts.error(err)
	})
}

function onForeground(): void {
	offlineSync.sync().catch(err => logger.warn("offline-sync", "Foreground transition sync failed", { error: err }))
}

// Host component mounted in the authed app shell (root _layout, alongside
// CameraUploadSync / NotesSync / ChatsSync). Kicks the initial offline index
// refresh + sync when the shell mounts in foreground, and re-syncs on every
// transition to foreground (offlineSync coalesces: auto passes within the
// min-interval of the last completed pass no-op); see useForegroundTrigger for the
// background-mount rule. A background mount's deferred first pass still refreshes the
// index, since offlineSync.runPass ends with updateIndex. Syncs on online transitions
// are driven by the reconnect listener (src/lib/reconnect.ts).
const OfflineSync = () => {
	useForegroundTrigger(onMountActive, onForeground)

	return null
}

export default OfflineSync
