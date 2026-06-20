import * as TaskManager from "expo-task-manager"
import * as BackgroundTask from "expo-background-task"
import { BackgroundTaskResult, BackgroundTaskStatus } from "expo-background-task"
import { Platform } from "react-native"
import logger from "@/lib/logger"
import { run } from "@filen/utils"
import setup from "@/lib/setup"
import cameraUpload from "@/features/cameraUpload/cameraUpload"
import offlineSync from "@/features/offline/offlineSync"
import secureStore from "@/lib/secureStore"
import { OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY } from "@/features/offline/offlineHelpers"
import cache from "@/lib/cache"
import { queryClientPersisterKv } from "@/queries/client"
import backgroundRunLog, { type BackgroundRunPhase } from "@/features/cameraUpload/backgroundRunLog"

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
	const startedAt = Date.now()

	// Run-log state, written as ONE breadcrumb after the run settles (audit B6): release
	// builds no-op console.* and both OS schedulers discard the returned result, so the
	// persisted entry is the only field-diagnosable trace of this run.
	let phase: BackgroundRunPhase = "setup"
	let cancelled = false

	const result = await run(async defer => {

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

		phase = "camera"

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

		if (!offlineEnabled) {
			phase = "done"

			return
		}

		if (cancelled) {
			return
		}

		const remaining = BACKGROUND_RUN_BUDGET_MS - (Date.now() - startedAt)

		if (remaining < OFFLINE_BACKGROUND_MIN_REMAINING_MS) {
			// Budget consumed by the camera phase — an intended outcome, not a cancel.
			phase = "done"

			return
		}

		phase = "offline"

		await offlineSync.sync({
			background: true
		})

		if (!cancelled) {
			phase = "done"
		}
	})

	// One breadcrumb per run, after the flush defers settled. Must never flip a healthy
	// run's outcome — a failed kv write only logs.
	await backgroundRunLog
		.append({
			v: 1,
			startedAt,
			finishedAt: Date.now(),
			phase,
			cancelled,
			result: result.success ? "success" : "failed",
			errorMessage: result.success ? undefined : result.error instanceof Error ? result.error.message : String(result.error)
		})
		.catch(err => {
			logger.warn("cameraUpload", "Failed to write background run log entry", { error: err })
		})

	if (!result.success) {
		logger.error("cameraUpload", "Background sync task failed", { phase, error: result.error })

		// Honest semantics note (audit B3, 2026-06-11): the INSTALLED expo-background-task
		// discards this value on both platforms — iOS always calls
		// task.setTaskCompleted(success: true) (BackgroundTaskAppDelegate.swift ignores the
		// completion result) and Android always returns WorkManager Result.success(). The
		// distinction is kept for OUR semantics: the test suite pins it and the run-log
		// breadcrumb above is the real failure record. An unauthed run is NOT a failure:
		// it returns Success above by design.
		return BackgroundTaskResult.Failed
	}

	return BackgroundTaskResult.Success
})

export async function registerBackgroundSync(): Promise<void> {
	try {
		const status = await BackgroundTask.getStatusAsync()

		if (status !== BackgroundTaskStatus.Available) {
			logger.warn("cameraUpload", "Background task not available", { status })

			return
		}

		await BackgroundTask.registerTaskAsync(TASK_NAME, {
			minimumInterval: 15
		})

		logger.debug("cameraUpload", "Registered background sync")
	} catch (e) {
		logger.error("cameraUpload", "Background task registration failed", { error: e })
	}
}

export async function unregisterBackgroundSync(): Promise<void> {
	try {
		const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME)

		if (!isRegistered) {
			return
		}

		await BackgroundTask.unregisterTaskAsync(TASK_NAME)

		logger.debug("cameraUpload", "Unregistered background sync")
	} catch (e) {
		logger.warn("cameraUpload", "Background task unregistration failed", { error: e })
	}
}
