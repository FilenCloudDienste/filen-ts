import { useEffect } from "react"
import { AppState } from "react-native"
import cameraUpload, { useCameraUpload } from "@/features/cameraUpload/cameraUpload"
import { registerBackgroundSync, unregisterBackgroundSync } from "@/features/cameraUpload/backgroundTask"
import { debounce } from "es-toolkit/function"

const syncDebounced = debounce(
	() => {
		cameraUpload.sync().catch(console.error)
	},
	5000,
	{
		edges: ["trailing"]
	}
)

let lastShouldRegisterBackground = false

const updateBackgroundTask = debounce(
	() => {
		if (lastShouldRegisterBackground) {
			registerBackgroundSync()
		} else {
			unregisterBackgroundSync()
		}
	},
	1000,
	{
		edges: ["trailing"]
	}
)

const CameraUploadSync = () => {
	const { config } = useCameraUpload()

	const shouldSync = config.enabled && config.remoteDir !== null && config.albumIds.length > 0
	const shouldRegisterBackground = shouldSync && config.background
	const albumIdsKey = config.albumIds.join(",")
	const remoteDirUuid = config.remoteDir?.inner[0].uuid

	useEffect(() => {
		cameraUpload.sync().catch(console.error)

		const appStateListener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				cameraUpload.sync().catch(console.error)
			}
		})

		return () => {
			appStateListener.remove()

			cameraUpload.cancel()
		}
	}, [])

	useEffect(() => {
		if (shouldSync) {
			syncDebounced()
		}
	}, [shouldSync, albumIdsKey, remoteDirUuid, config.afterActivation, config.activationTimestamp, config.includeVideos])

	useEffect(() => {
		lastShouldRegisterBackground = shouldRegisterBackground

		updateBackgroundTask()

		return () => {
			// Cancel the pending debounced register/unregister on unmount (and between
			// re-runs): a register left pending across logout would fire AFTER
			// auth.logout()'s unregisterBackgroundSync and re-register the task for a
			// logged-out app.
			updateBackgroundTask.cancel()
		}
	}, [shouldRegisterBackground])

	return null
}

export default CameraUploadSync
