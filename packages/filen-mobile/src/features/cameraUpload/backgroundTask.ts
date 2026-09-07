import * as TaskManager from "expo-task-manager"
import * as BackgroundTask from "expo-background-task"
import { BackgroundTaskResult, BackgroundTaskStatus } from "expo-background-task"
import { Platform } from "react-native"
import logger from "@/lib/logger"
import { run } from "@filen/utils"
import setup from "@/lib/setup"
import cameraUpload, { type CameraUploadSkipReason } from "@/features/cameraUpload/cameraUpload"
import offlineSync from "@/features/offline/offlineSync"
import notesOffline from "@/features/notes/notesOffline"
import secureStore from "@/lib/secureStore"
import { OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY } from "@/features/offline/offlineHelpers"
import { queryClientPersisterKv } from "@/queries/client"
import backgroundRunLog, { type BackgroundRunPhase } from "@/features/cameraUpload/backgroundRunLog"

const TASK_NAME = "filen-camera-upload-sync"

// Soft deadline for ONE background run, shared by every phase it drives (camera upload, the optional
// offline-files pass, and the offline-notes refresh). Platform context: iOS schedules this as a
// BGProcessingTask, which Apple documents as running "only when the device is idle" and terminating
// "any background processing tasks running when the user starts using the device"; Android runs it
// as a WorkManager worker, whose ListenableWorker contract gives "a maximum of ten minutes to
// finish its execution" before the future is cancelled and the result ignored.
//
// This deliberately stays at 2 minutes rather than growing toward those ceilings. Android
// meters background work by DURATION through App Standby Buckets — the documented regular-job
// quotas are 10 minutes per rolling 4h (working set) and per rolling 12h (frequent) — so at the
// 3-hourly cadence below a longer run would simply exhaust the quota and starve later fires:
// 120s x 4 runs = 480s fits inside a frequent-bucket window, 480s x 4 would not. The throughput
// fix is to USE this window (see the camera phase's deadlineAt), not to widen it.
export const BACKGROUND_RUN_BUDGET_MS = 120_000

// Head-room subtracted from the run budget for the camera phase's soft stop. Covers two things:
// transfers already in flight when the phase stops taking on new work need time to land (the
// alternative is the hard abort, which persists a background-abort against every one of them), and
// the two phases that follow need a window to clear their own floors below.
//
// It is head-room, not a hard guarantee — a single large video still in flight can outlast it — but
// it is a credible one now that the camera phase releases the window at three checkpoints instead of
// running a whole pipeline past the deadline.
export const CAMERA_PHASE_RESERVE_MS = 30_000

// Don't bother starting the offline pass when less than this remains of the run budget —
// a pass that gets aborted moments after its first listings is pure wasted network.
export const OFFLINE_BACKGROUND_MIN_REMAINING_MS = 15_000

// The offline-notes pass is usually far cheaper than the offline-files one: one listNotes call, then
// a body fetch per marked note that is stale OR missing from the cache. A smaller floor lets it still
// run in the tail of a budget the earlier phases mostly consumed.
export const NOTES_OFFLINE_BACKGROUND_MIN_REMAINING_MS = 5_000

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

	try {
		notesOffline.cancel()
	} catch (e) {
		logger.warn("cameraUpload", "notesOffline.cancel() threw during background cancel", { error: e })
	}
}

TaskManager.defineTask(TASK_NAME, async () => {
	const startedAt = Date.now()

	// Run-log state, written as ONE breadcrumb after the run settles (audit B6). Neither OS scheduler
	// sees the value this task returns, and a run that skips at a gate logs nothing, so the persisted
	// entry is the only guaranteed field-diagnosable trace of this run.
	let phase: BackgroundRunPhase = "setup"
	let cancelled = false
	// BG-01: cameraUpload.sync() never rejects (it swallows + store-logs its own failures), so a camera-
	// phase failure would otherwise leave the outer run() successful and the breadcrumb would record
	// "success" — blinding field diagnosis of "background uploads never run". Capture its surfaced
	// result so the breadcrumb + return reflect a camera failure symmetrically with the offline phase.
	let cameraFailed = false
	let cameraError: unknown = undefined
	// What the camera phase actually did, so the breadcrumb can tell "the OS never ran us" apart from
	// "we ran and a gate skipped us" apart from "we ran and uploaded".
	let cameraUploaded: number | undefined = undefined
	let cameraSkipReason: CameraUploadSkipReason | undefined = undefined

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
			// Only works because of the expo-background-task patch in patches/. Upstream's observer
			// guards on a userInfo["url"] that the poster never sets, so this event has never been
			// emitted in any released version and iOS expiration reached JS nowhere — the timer above
			// was the only bound. Do not drop that patch: with the camera phase now draining a whole
			// window, an unnoticed expiration means transfers cut mid-flight and no run breadcrumb.
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
			// No per-fire file cap: the window IS the budget. The phase drains newest-first until its
			// soft stop, then lets whatever is in flight land inside the reserve. A fixed cap of 3 used
			// to finish in seconds and hand the rest of the window back unused, which is why background
			// backup moved only a handful of photos a day while the uncapped foreground pass did the
			// real work. Staging stays bounded by the engine's Semaphore(4) regardless of how many
			// deltas the pass picks up, so draining longer costs window, not memory or disk.
			deadlineAt: startedAt + BACKGROUND_RUN_BUDGET_MS - CAMERA_PHASE_RESERVE_MS,
			background: true
		})

		cameraUploaded = cameraResult.uploaded
		cameraSkipReason = cameraResult.skipped

		if (!cameraResult.success) {
			cameraFailed = true
			cameraError = cameraResult.error
		}

		if (cancelled) {
			return
		}

		// Second phase: the budgeted offline FILES pass (default off; offline settings screen).
		// Skipped when the camera phase consumed the run budget.
		const offlineEnabled = (await secureStore.get<boolean>(OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY)) === true

		if (offlineEnabled && !cancelled && BACKGROUND_RUN_BUDGET_MS - (Date.now() - startedAt) >= OFFLINE_BACKGROUND_MIN_REMAINING_MS) {
			phase = "offline"

			await offlineSync.sync({
				background: true
			})
		}

		if (cancelled) {
			return
		}

		// Third phase: refresh the bodies of notes marked available offline. Intentionally NOT behind a
		// settings toggle — marking a note IS the opt-in — and it runs whether or not the offline-FILES
		// pass above was enabled: the two are unrelated opt-ins. This is the only trigger that reaches a
		// user who never opens the app while online, which is exactly the user the feature is for.
		//
		// It stays LAST despite that, because it cannot be bounded from here. notesOffline.sync() takes
		// no deadline, and its plan re-fetches every marked note whose cached body is MISSING, not only
		// those edited since the last pass — after a cache eviction that is the whole marked set. Ahead
		// of the camera phase it could therefore consume the entire window and starve photo backup, the
		// primary job; behind it, the worst case is that its own refresh waits for the next fire. What
		// protects it here is the camera phase's soft stop, which now releases the window at three
		// checkpoints rather than running a full pipeline past the deadline, so CAMERA_PHASE_RESERVE_MS
		// is a reserve the later phases can actually use.
		//
		// notesOffline.sync() never rejects, so a failure degrades to a logged warning and the next run
		// retries rather than failing the whole run.
		if (!cancelled && BACKGROUND_RUN_BUDGET_MS - (Date.now() - startedAt) >= NOTES_OFFLINE_BACKGROUND_MIN_REMAINING_MS) {
			phase = "notesOffline"

			await notesOffline.sync({
				background: true
			})
		}

		// Every path that reaches here finished what it intended, including the intended early ends
		// (offline disabled, budget consumed) — those are outcomes, not cancels.
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
			errorMessage: runFailed ? (runError instanceof Error ? runError.message : String(runError)) : undefined,
			cameraUploaded,
			cameraSkipReason
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
			// Minutes. Two independent reasons this stays at 3 hours rather than going shorter:
			//
			// Each fire pays a full bundle eval + cache/query restore, so rare fires that each drain a
			// whole window beat frequent fires that each pay that overhead for a few photos. And Android
			// meters jobs by DURATION, not by count — against the documented frequent-bucket quota of 10
			// minutes per rolling 12h, this cadence at BACKGROUND_RUN_BUDGET_MS costs 4 x 120s = 480s and
			// fits; at 2h it would be 6 x 120s = 720s and the OS would start refusing fires.
			//
			// iOS throttles background wakes far below this regardless (BGProcessingTask runs only when
			// the device is idle, at a time the system picks), and the foreground drain — uncapped and
			// unbudgeted — stays the primary path on both platforms.
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
