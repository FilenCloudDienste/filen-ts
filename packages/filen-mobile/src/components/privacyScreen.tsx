import { useEffect } from "react"
import { usePrivacyScreenEnabled, applyPrivacyScreen } from "@/features/settings/privacyScreen"

// Applies the native app-switcher / background privacy protection (expo-screen-capture) from the
// persisted "Privacy screen" setting. Replaces the old React FullWindowOverlay cover, which raced
// the OS multitasking snapshot (AppState → setState → render, often too late to redact). Native
// protection state resets on app restart, so this re-applies the persisted value on every mount;
// the useSecureStore-backed setting re-runs the effect when the Security toggle flips it.
// Mounted app-wide (not gated on auth) so it also covers the auth/login screens. Renders nothing.
function PrivacyScreen() {
	const [enabled] = usePrivacyScreenEnabled()

	useEffect(() => {
		// Log-only on failure — a privacy-protection call failing isn't user-actionable, and
		// alerting on every launch would be noise. The native module is first-party + reliable.
		applyPrivacyScreen(enabled).catch(console.error)
	}, [enabled])

	return null
}

export default PrivacyScreen
