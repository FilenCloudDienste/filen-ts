import { type AppStateStatus } from "react-native"

// Should we cancel foreground-scoped transfers (manual transfers and copies) on this AppState transition?
// Pure for testability. Act ONLY on the real "background" state, never the transient "inactive" (iOS
// app-switcher / a permission dialog / the privacy cover), so a momentary resign-active never cancels a
// healthy transfer. On Android a running foreground service keeps the process alive and the transfers
// progressing, so leave them be. Android also reports "background" for an in-app system presentation (the
// notification-permission prompt, a picker, the share sheet), which is not the user leaving; iOS reports
// those as "inactive", so there a "background" is always real.
export function shouldCancelForegroundOnBackground(
	nextAppState: AppStateStatus,
	platformOS: string,
	fgsRunning: boolean,
	presentationActive: boolean
): boolean {
	if (nextAppState !== "background") {
		return false
	}

	if (platformOS === "android" && (fgsRunning || presentationActive)) {
		return false
	}

	return true
}

// A "background" ignored for a presentation may still have been real (Home pressed while a picker was
// up). Once the presentation has ended and its grace has passed, an app still in the background is
// judged as if the presentation had never been there.
export function shouldCancelAfterPresentation(
	backgroundedBehindPresentation: boolean,
	currentAppState: AppStateStatus,
	platformOS: string,
	fgsRunning: boolean
): boolean {
	return backgroundedBehindPresentation && shouldCancelForegroundOnBackground(currentAppState, platformOS, fgsRunning, false)
}
