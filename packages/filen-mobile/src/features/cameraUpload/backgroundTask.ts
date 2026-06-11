import * as TaskManager from "expo-task-manager"
import * as BackgroundTask from "expo-background-task"
import { BackgroundTaskResult, BackgroundTaskStatus } from "expo-background-task"
import { Platform } from "react-native"
import { run } from "@filen/utils"
import setup from "@/lib/setup"
import cameraUpload from "@/features/cameraUpload/cameraUpload"
import offlineSync from "@/features/offline/offlineSync"
import secureStore from "@/lib/secureStore"
import { OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY } from "@/features/offline/offlineHelpers"

const TASK_NAME = "filen-camera-upload-sync"

// Soft deadline for ONE background run, covering camera upload AND the optional offline
// pass together. Platform context: iOS schedules this as a BGProcessingTask (minutes-class
// windows, expiration listener below is the authoritative kill signal); Android runs it as
// a WorkManager worker with a HARD 10-minute stop and NO expiration callback — the soft
// deadline is what keeps Android runs from being hard-killed mid-write. 2 minutes leaves
// generous headroom under both platforms' real limits.
export const BACKGROUND_RUN_BUDGET_MS = 120_000

// Don't bother starting the offline pass when less than this remains of the run budget —
// a pass that gets aborted moments after its first listings is pure wasted network.
export const OFFLINE_BACKGROUND_MIN_REMAINING_MS = 15_000

function cancelBackgroundWork(): void {
	cameraUpload.cancel()
	offlineSync.cancel()
}

TaskManager.defineTask(TASK_NAME, async () => {
	const result = await run(async defer => {
		const startedAt = Date.now()

		// Both engines abort safely mid-flight (aborted stores keep the old copy; every
		// pass re-converges on the next run), so the deadline simply cancels them.
		const deadlineTimer = setTimeout(cancelBackgroundWork, BACKGROUND_RUN_BUDGET_MS)

		defer(() => {
			clearTimeout(deadlineTimer)
		})

		if (Platform.OS === "ios") {
			const expirationListener = BackgroundTask.addExpirationListener(() => {
				cancelBackgroundWork()
			})

			defer(() => {
				expirationListener.remove()
			})
		}

		const { isAuthed } = await setup.setup({
			background: true
		})

		if (!isAuthed) {
			return
		}

		await cameraUpload.sync({
			maxUploads: 1,
			background: true
		})

		// Optional second phase: the budgeted offline pass (default off; offline settings
		// screen). Skipped when the camera phase consumed the run budget.
		const offlineEnabled = (await secureStore.get<boolean>(OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY)) === true

		if (!offlineEnabled) {
			return
		}

		const remaining = BACKGROUND_RUN_BUDGET_MS - (Date.now() - startedAt)

		if (remaining < OFFLINE_BACKGROUND_MIN_REMAINING_MS) {
			return
		}

		await offlineSync.sync({
			background: true
		})
	})

	if (!result.success) {
		console.error("[BackgroundTask] Background sync run failed:", result.error)

		// The OS schedulers feed this into their retry/budget heuristics — a broken run
		// (setup failure, sync rejection) must not be reported as a healthy one. An
		// unauthed run is NOT a failure: it returns Success above by design.
		return BackgroundTaskResult.Failed
	}

	return BackgroundTaskResult.Success
})

export async function registerBackgroundSync(): Promise<void> {
	try {
		const status = await BackgroundTask.getStatusAsync()

		if (status !== BackgroundTaskStatus.Available) {
			console.warn(`[BackgroundTask] Background sync not available: ${status}`)

			return
		}

		await BackgroundTask.registerTaskAsync(TASK_NAME, {
			minimumInterval: 15
		})

		console.log("[BackgroundTask] Registered background sync")
	} catch (e) {
		console.error("[BackgroundTask] Failed to register:", e)
	}
}

export async function unregisterBackgroundSync(): Promise<void> {
	try {
		const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME)

		if (!isRegistered) {
			return
		}

		await BackgroundTask.unregisterTaskAsync(TASK_NAME)

		console.log("[BackgroundTask] Unregistered background sync")
	} catch (e) {
		console.error("[BackgroundTask] Failed to unregister:", e)
	}
}
