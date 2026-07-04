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
//   - pipPreviewVisible: an active Picture-in-Picture session with the drivePreview route as the app's
//     last-visible screen (spec: docs/pip-video-player.md §5.6.2). The user deliberately floated this
//     video on screen — the app-window snapshot can only show the preview scaffolding around it, so the
//     cover is suppressed. The pathname condition is load-bearing: the preview header's menu can push
//     full screens (Move → a drive browser) OVER the mounted preview while PiP is alive — those must
//     redact, so the caller computes this as pipActive AND pathname === drivePreview.
export function shouldRedact(
	appState: AppStateStatus,
	presentationSuppressed: boolean,
	biometricLocked: boolean,
	pipPreviewVisible: boolean
): boolean {
	if (biometricLocked) {
		return false
	}

	if (pipPreviewVisible) {
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
