import { useEffect, memo } from "react"
import { AppState } from "react-native"
import cameraUpload, { useCameraUpload } from "@/lib/cameraUpload"
import { registerBackgroundSync, unregisterBackgroundSync } from "@/lib/backgroundTask"
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

const CameraUploadSync = memo(() => {
	const { config } = useCameraUpload()

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

	const shouldSync = config.enabled && config.remoteDir !== null && config.albumIds.length > 0
	const shouldRegisterBackground = shouldSync && config.background
	const albumIdsKey = config.albumIds.join(",")

	useEffect(() => {
		if (shouldSync) {
			syncDebounced()
		}
	}, [shouldSync, albumIdsKey, config.remoteDir?.uuid, config.afterActivation, config.activationTimestamp, config.includeVideos])

	useEffect(() => {
		lastShouldRegisterBackground = shouldRegisterBackground

		updateBackgroundTask()
	}, [shouldRegisterBackground])

	return null
})

export default CameraUploadSync
