import { useEffect } from "react"
import { AppState, type AppStateStatus, Platform } from "react-native"
import { runEffect } from "@filen/shared"
import transfers from "@/features/transfers/transfers"
import foregroundService from "@/features/transfers/foregroundService"
import { shouldCancelAfterPresentation, shouldCancelForegroundOnBackground } from "@/features/transfers/components/transferLifecycle.utils"
import { RELOCK_SUPPRESSION_GRACE_MS, systemPresentation, useSystemPresentationStore } from "@/lib/systemPresentation"

// Shell component (renders nothing): on app→background, cancel the FOREGROUND transfer scope so manual
// transfers and copies that cannot complete while backgrounded are torn down immediately instead of
// stalling on a dead socket and pinning the SDK's shared permits. Sync-engine transfers run in the
// BACKGROUND scope and are untouched. isRunning() is a best-effort mirror; on drift it falls back to the
// SDK's keepalive teardown. Resuming cancelled transfers on foreground is out of scope.
const TransferLifecycle = () => {
	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			let backgroundedBehindPresentation = false
			let presentationEndCheck: ReturnType<typeof setTimeout> | null = null

			const clearPresentationEndCheck = () => {
				if (presentationEndCheck) {
					clearTimeout(presentationEndCheck)

					presentationEndCheck = null
				}
			}

			const subscription = AppState.addEventListener("change", (nextAppState: AppStateStatus) => {
				if (nextAppState === "active") {
					backgroundedBehindPresentation = false

					clearPresentationEndCheck()

					return
				}

				const fgsRunning = foregroundService.isRunning()
				const presentationActive = systemPresentation.isActive()

				if (shouldCancelForegroundOnBackground(nextAppState, Platform.OS, fgsRunning, presentationActive)) {
					transfers.cancelForegroundTransfers()

					return
				}

				if (nextAppState === "background" && presentationActive) {
					backgroundedBehindPresentation = true
				}
			})

			// A picker's result reaches JS before the app reports "active" again, so the check waits out the
			// same grace the biometric re-lock uses.
			const presentationSubscription = useSystemPresentationStore.subscribe((state, prevState) => {
				if (!backgroundedBehindPresentation || !(prevState.activeCount > 0 && state.activeCount === 0)) {
					return
				}

				clearPresentationEndCheck()

				presentationEndCheck = setTimeout(() => {
					presentationEndCheck = null

					if (
						shouldCancelAfterPresentation(
							backgroundedBehindPresentation,
							AppState.currentState,
							Platform.OS,
							foregroundService.isRunning()
						)
					) {
						transfers.cancelForegroundTransfers()
					}

					backgroundedBehindPresentation = false
				}, RELOCK_SUPPRESSION_GRACE_MS)
			})

			defer(() => {
				subscription.remove()
				presentationSubscription()
				clearPresentationEndCheck()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	return null
}

export default TransferLifecycle
