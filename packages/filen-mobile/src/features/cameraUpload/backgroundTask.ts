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
import cache from "@/lib/cache"
import { queryClientPersisterKv } from "@/queries/client"

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

		// Persist-before-suspend: the debounced persisters (cache.ts PersistentMaps —
		// camera-upload hashes; QueryPersisterKv — storedOffline query broadcasts) normally
		// flush on the AppState "background" transition, which never fires in a headless
		// run (the app is ALREADY backgrounded), and the OS may suspend the process the
		// moment this callback returns. Registered FIRST so the LIFO defer order runs it
		// LAST — after the deadline timer is cleared and the expiration listener removed.
		// Both flushNow()s never reject and no-op when clean, so this covers every exit
		// path (early returns and failures) for free.
		defer(async () => {
			await Promise.all([cache.flushNow(), queryClientPersisterKv.flushNow()])
		})

		// Both engines abort safely mid-flight (aborted stores keep the old copy; every
		// pass re-converges on the next run), so the deadline simply cancels them. The
		// flag exists because cancel() swaps in a FRESH AbortController for the next run:
		// a cancel landing between phases aborts nothing, so a not-yet-started phase
		// would otherwise run un-aborted (e.g. an iOS expiration at t=30s leaves
		// remaining = 90s > the min-remaining gate). Once cancelled, no phase starts.
		let cancelled = false

		const cancelRun = (): void => {
			cancelled = true

			cancelBackgroundWork()
		}

		const deadlineTimer = setTimeout(cancelRun, BACKGROUND_RUN_BUDGET_MS)

		defer(() => {
			clearTimeout(deadlineTimer)
		})

		if (Platform.OS === "ios") {
			const expirationListener = BackgroundTask.addExpirationListener(cancelRun)

			defer(() => {
				expirationListener.remove()
			})
		}

		const { isAuthed } = await setup.setup({
			background: true
		})

		if (!isAuthed || cancelled) {
			return
		}

		await cameraUpload.sync({
			maxUploads: 1,
			background: true
		})

		if (cancelled) {
			return
		}

		// Optional second phase: the budgeted offline pass (default off; offline settings
		// screen). Skipped when the camera phase consumed the run budget.
		const offlineEnabled = (await secureStore.get<boolean>(OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY)) === true

		if (!offlineEnabled || cancelled) {
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
