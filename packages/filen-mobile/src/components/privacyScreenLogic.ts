import { type AppStateStatus } from "react-native"

// Pure decision for the privacy cover's redaction (extracted from the component for unit testing).
//
// Coordinates with the biometric lock and in-app native presentations:
//   - biometricLocked: the biometric lock overlay is already up and opaque, so it redacts the snapshot
//     itself — the cover defers to it ("lock wins") so the two overlays never stack or flicker.
//   - "active": the app is foreground — never redact.
//   - "background": the real app-switcher / recents snapshot — ALWAYS redact, ignoring the presentation
//     grace; a snapshot must never leak real content.
//   - "inactive": the transitional resign-active state. An in-app native presentation (Face ID / PIN /
//     picker / share sheet) resigns the app active without truly leaving, so suppress the cover during it
//     AND for the systemPresentation grace window after (presentationSuppressed) — otherwise the cover
//     flickers around the prompt. A plain home-press also passes through "inactive", but with no
//     presentation active (presentationSuppressed === false), so it redacts immediately.
export function shouldRedact(appState: AppStateStatus, presentationSuppressed: boolean, biometricLocked: boolean): boolean {
	if (biometricLocked) {
		return false
	}

	if (appState === "active") {
		return false
	}

	if (appState === "background") {
		return true
	}

	return !presentationSuppressed
}
