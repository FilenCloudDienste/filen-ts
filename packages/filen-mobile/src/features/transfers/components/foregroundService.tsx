import { useEffect } from "react"
import { Platform } from "react-native"
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

		const handle = (state: TransfersStore) => {
			const count = state.transfers.length
			const { progress, speed } = state.stats
			const snapshot = { count, progress, speed }

			if (count > 0 && lastCount === 0) {
				pendingStart = new AbortController()

				const signal = pendingStart.signal

				inFlight = inFlight.then(() => foregroundService.start(snapshot, signal)).catch(err => logger.error("transfers-fgs", "Foreground service start failed", { error: err }))
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

		return () => {
			unsubscribe()

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
