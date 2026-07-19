import { useEffect } from "react"
import { Platform, AppState } from "react-native"
import logger from "@/lib/logger"
import foregroundService, {
	TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY,
	DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED
} from "@/features/transfers/foregroundService"
import useTransfersStore, { type TransfersStore } from "@/features/transfers/store/useTransfers.store"
import { useSecureStore } from "@/lib/secureStore"

function ForegroundService() {
	const [enabled] = useSecureStore<boolean>(
		TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY,
		DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED
	)

	useEffect(() => {
		// Re-runs when `enabled` flips: turning it off tears down this effect (its cleanup stops a
		// running service); turning it on re-subscribes and starts one if transfers are already active.
		if (Platform.OS !== "android" || !enabled) {
			return
		}

		let lastCount = 0
		let lastProgress = -1
		let lastSpeed = -1
		let inFlight: Promise<void> = Promise.resolve()
		let pendingStart: AbortController | null = null

		// (Re)arm the foreground service for an active transfer. Idempotent: no-ops when there is
		// nothing to protect, a start is already in flight, or the service is already running. The
		// pendingStart controller is cleared once the attempt settles (TC-10) — so a start that was
		// rejected because the app was backgrounded (Android 12+ forbids background FGS starts) can be
		// retried by the AppState→active handler below, where the start is allowed.
		const attemptStart = (snapshot: { count: number; progress: number; speed: number }): void => {
			// Only START from the foreground. Calling startForegroundService() while the app is
			// backgrounded/frozen risks ForegroundServiceDidNotStartInTimeException — an UNCATCHABLE
			// async system kill fired when the frozen process misses the ~5s startForeground()
			// deadline. A transfer that begins while backgrounded (reconnect → camera-upload/offline
			// sync enqueues) defers here; the AppState→active listener below re-attempts once
			// foreground, where promotion is safe.
			if (snapshot.count === 0 || pendingStart || foregroundService.isRunning() || AppState.currentState !== "active") {
				return
			}

			const controller = new AbortController()

			pendingStart = controller

			inFlight = inFlight
				.then(() => foregroundService.start(snapshot, controller.signal))
				.catch(err => logger.error("transfers-fgs", "Foreground service start failed", { error: err }))
				.finally(() => {
					if (pendingStart === controller) {
						pendingStart = null
					}
				})
		}

		const handle = (state: TransfersStore) => {
			const count = state.transfers.length
			const { progress, speed } = state.stats
			const snapshot = { count, progress, speed }

			if (count > 0 && lastCount === 0) {
				attemptStart(snapshot)
			} else if (count === 0 && lastCount > 0) {
				if (pendingStart) {
					pendingStart.abort()
					pendingStart = null
				}

				inFlight = inFlight.then(() => foregroundService.stop()).catch(err => logger.error("transfers-fgs", "Foreground service stop failed", { error: err }))
			} else if (count > 0 && (count !== lastCount || progress !== lastProgress || speed !== lastSpeed)) {
				inFlight = inFlight.then(() => foregroundService.update(snapshot)).catch(err => logger.warn("transfers-fgs", "Foreground service update failed", { error: err }))
			}

			lastCount = count
			lastProgress = progress
			lastSpeed = speed
		}

		handle(useTransfersStore.getState())

		const unsubscribe = useTransfersStore.subscribe(handle)

		// TC-10: a transfer can begin while the app is backgrounded-but-alive (reconnect/foreground-
		// transition kicks camera-upload + offline sync, which enqueue transfers). The 0→>0 edge above
		// then calls start() from the background, where Android rejects it — and the edge never fires
		// again. On return to the foreground, retry start() for any still-active, not-yet-running transfer.
		const appStateSubscription = AppState.addEventListener("change", nextState => {
			if (nextState !== "active") {
				return
			}

			const state = useTransfersStore.getState()

			attemptStart({ count: state.transfers.length, progress: state.stats.progress, speed: state.stats.speed })
		})

		return () => {
			unsubscribe()
			appStateSubscription.remove()

			if (pendingStart) {
				pendingStart.abort()
				pendingStart = null
			}

			inFlight = inFlight.then(() => foregroundService.stop()).catch(err => logger.error("transfers-fgs", "Foreground service stop failed on cleanup", { error: err }))
		}
	}, [enabled])

	return null
}

export default ForegroundService
