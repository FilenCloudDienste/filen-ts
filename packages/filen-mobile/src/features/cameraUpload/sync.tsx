import { useEffect } from "react"
import { AppState } from "react-native"
import logger from "@/lib/logger"
import cameraUpload, { useCameraUpload } from "@/features/cameraUpload/cameraUpload"
import { registerBackgroundSync, unregisterBackgroundSync } from "@/features/cameraUpload/backgroundTask"
import { debounce } from "es-toolkit/function"
import { useSecureStore } from "@/lib/secureStore"
import { OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY } from "@/features/offline/offlineHelpers"
import auth from "@/lib/auth"
import { Semaphore } from "@filen/utils"

const syncDebounced = debounce(
	() => {
		cameraUpload.sync().catch(err => logger.warn("cameraUpload", "Debounced sync failed", { error: err }))
	},
	5000,
	{
		edges: ["trailing"]
	}
)

let lastShouldRegisterBackground = false

// register/unregister both mutate the SAME OS task name and are async. Serialize them so the
// LAST requested state always wins: the 1s debounce only coalesces toggles inside one quiet
// window, so two toggles spaced >1s apart would otherwise run as two un-ordered in-flight
// native round trips whose completion order isn't guaranteed (CU-02). One-permit lock + reading
// the desired state AFTER acquiring it means a stale in-flight op can never overtake a newer one.
const backgroundTaskRegistrationMutex = new Semaphore(1)

async function applyBackgroundTaskRegistration(): Promise<void> {
	await backgroundTaskRegistrationMutex.acquire()

	try {
		// Read the desired state here, under the lock, so the op that actually runs reflects the
		// latest requested value rather than the snapshot captured when the debounce fired.
		if (lastShouldRegisterBackground) {
			// Never (re-)register for a logged-out app (CU-03): the 1s register debounce can elapse
			// inside the logout window — after auth.doLogout()'s Phase-1 unregisterBackgroundSync()
			// resolved but before this component's async (re-render-driven) unmount cleanup runs and
			// before Phase-7 reloadAppAsync() tears down the JS context — and would otherwise
			// re-register the task using the stale pre-logout lastShouldRegisterBackground. Once the
			// auth secret is wiped (logout Phase 6) isAuthed() is false, so the register is refused;
			// the residual pre-wipe sub-window stays backstopped by the JS-bundle reload.
			const { isAuthed } = await auth.isAuthed()

			if (!isAuthed) {
				return
			}

			await registerBackgroundSync()
		} else {
			await unregisterBackgroundSync()
		}
	} finally {
		backgroundTaskRegistrationMutex.release()
	}
}

const updateBackgroundTask = debounce(
	() => {
		applyBackgroundTaskRegistration().catch(err =>
			logger.warn("cameraUpload", "Background task registration update failed", { error: err })
		)
	},
	1000,
	{
		edges: ["trailing"]
	}
)

const CameraUploadSync = () => {
	const { config } = useCameraUpload()
	// The single OS background task serves BOTH background producers (camera upload and
	// the budgeted offline pass) — registration must follow the OR of their settings, or
	// enabling offline-background alone would never schedule the task. This component is
	// always mounted while authenticated, so it owns the combined registration.
	const [offlineBackgroundSync] = useSecureStore<boolean>(OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY, false)

	const shouldSync = config.enabled && config.remoteDir !== null && config.albumIds.length > 0
	const shouldRegisterBackground = (shouldSync && config.background) || offlineBackgroundSync === true
	const albumIdsKey = config.albumIds.join(",")
	const remoteDirUuid = config.remoteDir?.inner[0].uuid

	useEffect(() => {
		// Mount ≠ foreground: an iOS cold background launch (BGProcessingTask) mounts the
		// tree with AppState "background" — this unbudgeted sync would race the budgeted
		// background-task sync (maxUploads: 1) for the engine's syncing flag. The listener
		// below covers the deferred first sync on the real "active" transition.
		if (AppState.currentState === "active") {
			cameraUpload.sync().catch(err => logger.warn("cameraUpload", "Mount sync failed", { error: err }))
		}

		const appStateListener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				cameraUpload.sync().catch(err => logger.warn("cameraUpload", "Foreground transition sync failed", { error: err }))
			}
		})

		return () => {
			appStateListener.remove()

			cameraUpload.cancel()

			// Symmetric timer hygiene with updateBackgroundTask.cancel() below (CU-04): the 5s
			// syncDebounced is armed by the config-change effect. The component's only unmount path
			// is logout (it is gated on isAuthed), so a pending fire would otherwise call
			// cameraUpload.sync() up to 5s later against torn-down/cleared post-logout state.
			syncDebounced.cancel()
		}
	}, [])

	useEffect(() => {
		// Same mount-vs-foreground guard as above: the initial run of this effect must not
		// fire an unbudgeted sync during a background launch. Genuine config changes only
		// happen from foreground UI, so the guard never skips a real change.
		if (shouldSync && AppState.currentState === "active") {
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
