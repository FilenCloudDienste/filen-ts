import { useEffect } from "react"
import { AppState, type AppStateStatus, Platform } from "react-native"
import { runEffect } from "@filen/utils"
import transfers from "@/features/transfers/transfers"
import foregroundService from "@/features/transfers/foregroundService"
import { shouldCancelForegroundOnBackground } from "@/features/transfers/components/transferLifecycle.utils"

// Shell component (renders nothing): on app→background, cancel the FOREGROUND transfer scope so manual
// transfers that cannot complete while backgrounded are torn down immediately instead of stalling on a dead
// socket and pinning the SDK's shared permits. Sync-engine transfers run in the BACKGROUND scope and are
// untouched. isRunning() is a best-effort mirror; on drift it falls back to the SDK's keepalive teardown.
// Resuming cancelled transfers on foreground is out of scope.
const TransferLifecycle = () => {
	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const subscription = AppState.addEventListener("change", (nextAppState: AppStateStatus) => {
				if (shouldCancelForegroundOnBackground(nextAppState, Platform.OS, foregroundService.isRunning())) {
					transfers.cancelForegroundTransfers()
				}
			})

			defer(() => {
				subscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	return null
}

export default TransferLifecycle
