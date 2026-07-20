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
	// BG-02: isolate each cancel so a throw in one engine can't block the other's cancel or escape the
	// deadline timer / iOS expiration callback this runs from (mirrors auth.ts logout's per-step isolation).
	try {
		cameraUpload.cancel()
	} catch (e) {
		logger.warn("cameraUpload", "cameraUpload.cancel() threw during background cancel", { error: e })
	}

	try {
		offlineSync.cancel()
	} catch (e) {
		logger.warn("cameraUpload", "offlineSync.cancel() threw during background cancel", { error: e })
	}
}

TaskManager.defineTask(TASK_NAME, async () => {
	const startedAt = Date.now()

	// Run-log state, written as ONE breadcrumb after the run settles (audit B6): release
	// builds no-op console.* and both OS schedulers discard the returned result, so the
	// persisted entry is the only field-diagnosable trace of this run.
	let phase: BackgroundRunPhase = "setup"
	let cancelled = false
	// BG-01: cameraUpload.sync() never rejects (it swallows + store-logs its own failures), so a camera-
	// phase failure would otherwise leave the outer run() successful and the breadcrumb would record
	// "success" — blinding field diagnosis of "background uploads never run". Capture its surfaced
	// result so the breadcrumb + return reflect a camera failure symmetrically with the offline phase.
	let cameraFailed = false
	let cameraError: unknown = undefined

	const result = await run(async defer => {

		// Persist-before-suspend: the storedOffline query broadcasts still debounce through
		// QueryPersisterKv, which normally flushes on the AppState "background" transition —
		// never fired in a headless run (the app is ALREADY backgrounded), and the OS may suspend
		// the process the moment this callback returns. The camera-upload ledger now writes through
		// synchronously (cameraUploadState), so only the query persister needs a flush. Registered
		// FIRST so the LIFO defer order runs it LAST — after the deadline timer is cleared and the
		// expiration listener removed. flushNow() never rejects and no-ops when clean, so this
		// covers every exit path (early returns and failures) for free.
		defer(async () => {
			await queryClientPersisterKv.flushNow()
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

		const cameraResult = await cameraUpload.sync({
			// Best-effort per fire: staging runs up to Semaphore(4) concurrent with per-decode
			// release, and the run budget + expiration abort naturally cap it — a slow connection
			// just uploads 1-2 and the rest roll to the next fire.
			maxUploads: 3,
			background: true
		})

		if (!cameraResult.success) {
			cameraFailed = true
			cameraError = cameraResult.error
		}

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

	// A run is a failure if the outer run() threw (offline phase rejects) OR the camera phase surfaced
	// a swallowed failure (BG-01). errorMessage prefers the outer error (offline) when present, else
	// the camera error.
	const runFailed = !result.success || cameraFailed
	const runError = !result.success ? result.error : cameraError

	// One breadcrumb per run, after the flush defers settled. Must never flip a healthy
	// run's outcome — a failed kv write only logs.
	await backgroundRunLog
		.append({
			v: 1,
			startedAt,
			finishedAt: Date.now(),
			phase,
			cancelled,
			result: runFailed ? "failed" : "success",
			errorMessage: runFailed ? (runError instanceof Error ? runError.message : String(runError)) : undefined
		})
		.catch(err => {
			logger.warn("cameraUpload", "Failed to write background run log entry", { error: err })
		})

	if (runFailed) {
		logger.error("cameraUpload", "Background sync task failed", { phase, cameraFailed, error: runError })

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
			// Minutes. Each fire pays a full bundle eval + cache/query restore, so keep fires rare
			// (~8/day) and let each drain up to maxUploads photos above — same daily throughput as
			// a 1h/1-upload cadence at a third of the cost. iOS throttles background wakes far below
			// this regardless, and the foreground drain stays the primary path.
			minimumInterval: 180
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
