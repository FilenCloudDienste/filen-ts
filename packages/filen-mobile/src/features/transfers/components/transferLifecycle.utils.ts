import { type AppStateStatus } from "react-native"

// Should we cancel foreground-scoped transfers on this AppState transition? Pure for testability. Act ONLY
// on the real "background" state, never the transient "inactive" (iOS app-switcher / a permission dialog /
// the privacy cover), so a momentary resign-active never cancels a healthy transfer. On Android a running
// foreground service keeps the process alive and the transfers progressing, so leave them be.
export function shouldCancelForegroundOnBackground(nextAppState: AppStateStatus, platformOS: string, fgsRunning: boolean): boolean {
	if (nextAppState !== "background") {
		return false
	}

	if (platformOS === "android" && fgsRunning) {
		return false
	}

	return true
}
