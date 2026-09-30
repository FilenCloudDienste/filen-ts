import { useEffect } from "react"
import { AppState } from "react-native"

/**
 * Runs `onMountActive` on mount only if the app is already active, and `onForeground` on every
 * later transition to "active".
 *
 * Mount is not foreground: an iOS cold background launch (BGProcessingTask) mounts the tree with
 * AppState "background", and an unbudgeted pass started there would win the mutex against the
 * budgeted pass the background task runs. Background mounts get their first pass from the first
 * real "active" transition instead.
 *
 * Pass module-level (stable) functions, never inline closures: a new identity re-subscribes and
 * re-runs the mount check.
 */
export default function useForegroundTrigger(onMountActive: () => void, onForeground: () => void): void {
	useEffect(() => {
		if (AppState.currentState === "active") {
			onMountActive()
		}

		const subscription = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				onForeground()
			}
		})

		return () => {
			subscription.remove()
		}
	}, [onMountActive, onForeground])
}
