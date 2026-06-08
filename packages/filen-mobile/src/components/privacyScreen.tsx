import { useEffect } from "react"
import { usePrivacyScreenEnabled, applyPrivacyScreen } from "@/features/settings/privacyScreen"
import { systemPresentation } from "@/lib/systemPresentation"

// Applies the native app-switcher / background privacy protection (expo-screen-capture) from the
// persisted "Privacy screen" setting. Replaces the old React FullWindowOverlay cover, which raced
// the OS multitasking snapshot (AppState → setState → render, often too late to redact). Native
// protection state resets on app restart, so this re-applies the persisted value on every mount;
// the useSecureStore-backed setting re-runs the effect when the Security toggle flips it.
// Mounted app-wide (not gated on auth) so it also covers the auth/login screens. Renders nothing.
//
// The native protection arms on willResignActive, which an in-app system prompt (Face ID, an
// image/document picker, a permission dialog) ALSO fires — flashing the blur even though the user
// never left the app. To avoid that, this host registers a suppressor with systemPresentation: while
// any wrapped presentation is on screen the blur is lifted, then restored to the persisted setting.
function PrivacyScreen() {
	const [enabled] = usePrivacyScreenEnabled()

	useEffect(() => {
		// Apply the persisted setting now, honoring any in-flight presentation (so we don't re-arm the
		// blur on top of a picker that's already open when the setting changes mid-presentation).
		// Log-only on failure — a privacy-protection call failing isn't user-actionable, and alerting
		// on every launch would be noise. The native module is first-party + reliable.
		applyPrivacyScreen(enabled && !systemPresentation.isActive()).catch(console.error)

		// Lift the blur around any in-app native presentation and restore it (to the persisted setting)
		// when it ends. Called on the 0→1 / 1→0 transitions, before the prompt resigns the app active.
		return systemPresentation.registerSuppressor(async suppressed => {
			await applyPrivacyScreen(enabled && !suppressed)
		})
	}, [enabled])

	return null
}

export default PrivacyScreen
