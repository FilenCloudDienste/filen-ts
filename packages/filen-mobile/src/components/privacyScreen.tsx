import { useEffect, useState } from "react"
import { Platform, AppState } from "react-native"
import { FullWindowOverlay } from "react-native-screens"
import { FadeOut } from "react-native-reanimated"
import { usePreventScreenCapture } from "expo-screen-capture"
import { AnimatedView } from "@/components/ui/animated"
import { usePrivacyScreenEnabled } from "@/features/settings/privacyScreen"
import { useSystemPresentationStore, systemPresentation } from "@/lib/systemPresentation"
import useAppStore from "@/stores/useApp.store"
import usePipStore from "@/stores/usePip.store"
import { shouldRedact } from "@/components/privacyScreenLogic"

const COVER_CLASSES = "absolute top-0 left-0 right-0 bottom-0 z-10000 w-full h-full bg-background"

// expo-screen-capture key — scopes our prevent/allow pair so it never conflicts with any other caller.
const SCREEN_CAPTURE_KEY = "privacy-screen"

// Resolves the live redaction inputs into a boolean (iOS cover only). Non-reactive reads (AppState.currentState
// + store getStates); PrivacyCover re-runs this on the relevant subscriptions. presentationSuppressed uses the
// grace-inclusive isReLockSuppressed so the cover rides out the brief "inactive" transitions around an in-app
// prompt without flickering; shouldRedact's "background" branch ignores the grace so a real snapshot is never
// left uncovered.
function computeShouldRedact(): boolean {
	const appState = AppState.currentState
	const presentationSuppressed = systemPresentation.isReLockSuppressed()
	const biometricLocked = useAppStore.getState().biometricUnlocked === false
	// PiP suppression is pathname-gated (spec: docs/pip-video-player.md §5.6.2): the preview
	// header's menu can push full screens over the mounted preview while a PiP session is alive —
	// only the preview itself may go uncovered.
	const pipPreviewVisible = usePipStore.getState().activeKey !== null && useAppStore.getState().pathname.startsWith("/drivePreview")

	return shouldRedact(appState, presentationSuppressed, biometricLocked, pipPreviewVisible)
}

// iOS privacy cover. Redacts the app-switcher snapshot while the app is not active, defers to the biometric
// lock when it is up, and stays hidden while (and just after) an in-app native presentation is on screen.
//
// iOS-only: a FullWindowOverlay (window-level — sits ABOVE native pageSheet/formSheet modals), conditionally
// mounted with a STATIC opaque bg-background AnimatedView + exiting={FadeOut} for the fade-out. Mount/unmount
// is correct by construction (nothing is in the tree when we should not redact); pointerEvents="none" lets
// touches pass through during the exiting fade. (Android does NOT use this — see AndroidScreenCaptureGuard.)
function PrivacyCover() {
	const [redact, setRedact] = useState<boolean>(() => computeShouldRedact())

	useEffect(() => {
		const apply = (): void => {
			setRedact(computeShouldRedact())
		}

		apply()

		const appStateSub = AppState.addEventListener("change", apply)
		const unsubPresentation = useSystemPresentationStore.subscribe(apply)
		const unsubApp = useAppStore.subscribe(apply)
		const unsubPip = usePipStore.subscribe(apply)

		return () => {
			appStateSub.remove()
			unsubPresentation()
			unsubApp()
			unsubPip()
		}
	}, [])

	if (!redact) {
		return null
	}

	return (
		<FullWindowOverlay>
			<AnimatedView
				className={COVER_CLASSES}
				exiting={FadeOut}
				pointerEvents="none"
			/>
		</FullWindowOverlay>
	)
}

// Android redaction: FLAG_SECURE via expo-screen-capture, held for as long as this component is mounted (i.e.
// for as long as the Privacy Screen setting is on). The OS blanks the recents/app-switcher snapshot ITSELF, at
// the moment of backgrounding — BEFORE any JS overlay could mount. That is exactly the race a React cover loses
// on Android (the snapshot is already captured by the time the cover mounts), and the reason the old Android
// cover only ever painted the live app black instead of redacting anything. Trade-off: FLAG_SECURE also blocks
// screenshots + screen recording while the setting is on — a deliberate, accepted cost for "hide the app in the
// app switcher" on Android (the user opts in via the Privacy Screen toggle).
function AndroidScreenCaptureGuard() {
	usePreventScreenCapture(SCREEN_CAPTURE_KEY)

	return null
}

function PrivacyScreen() {
	const [enabled] = usePrivacyScreenEnabled()

	if (!enabled) {
		return null
	}

	if (Platform.OS === "android") {
		return <AndroidScreenCaptureGuard />
	}

	return <PrivacyCover />
}

export default PrivacyScreen
