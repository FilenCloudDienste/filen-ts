import { useEffect } from "react"
import { Platform } from "react-native"
import foregroundService from "@/lib/foregroundService"
import useTransfersStore, { type TransfersStore } from "@/stores/useTransfers.store"

function ForegroundService() {
	useEffect(() => {
		if (Platform.OS !== "android") {
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

				inFlight = inFlight.then(() => foregroundService.start(snapshot, signal)).catch(console.error)
			} else if (count === 0 && lastCount > 0) {
				if (pendingStart) {
					pendingStart.abort()
					pendingStart = null
				}

				inFlight = inFlight.then(() => foregroundService.stop()).catch(console.error)
			} else if (count > 0 && (count !== lastCount || progress !== lastProgress || speed !== lastSpeed)) {
				inFlight = inFlight.then(() => foregroundService.update(snapshot)).catch(console.error)
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

			inFlight = inFlight.then(() => foregroundService.stop()).catch(console.error)
		}
	}, [])

	return null
}

export default ForegroundService
