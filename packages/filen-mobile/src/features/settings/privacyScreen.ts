import { Platform } from "react-native"
import * as ScreenCapture from "expo-screen-capture"
import { useSecureStore } from "@/lib/secureStore"

// secureStore key for the "Privacy screen" setting. Boolean; absent/false → no redaction (the
// default — privacy screen is opt-in). Read by the <PrivacyScreen /> shell host (which applies the
// native protection) and written by the Security settings toggle.
export const PRIVACY_SCREEN_ENABLED_SECURE_STORE_KEY = "privacyScreenEnabled"

export const DEFAULT_PRIVACY_SCREEN_ENABLED = false

// iOS app-switcher blur strength (0–1) for the privacy overlay. 0.5 is expo-screen-capture's
// default light blur; raise toward 1 for a heavier blur. iOS only — Android uses FLAG_SECURE,
// which fully blanks the recents preview (no intensity).
export const PRIVACY_SCREEN_BLUR_INTENSITY = 0.5

export function usePrivacyScreenEnabled(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
	return useSecureStore<boolean>(PRIVACY_SCREEN_ENABLED_SECURE_STORE_KEY, DEFAULT_PRIVACY_SCREEN_ENABLED)
}

// Apply the native app-switcher / background privacy protection for the given setting, via the
// first-party expo-screen-capture module. Recents-redaction only (per product decision):
//   - iOS:     app-switcher blur overlay (enable/disableAppSwitcherProtectionAsync). Screenshots
//              stay allowed.
//   - Android: FLAG_SECURE (prevent/allowScreenCaptureAsync), which blanks the recents preview —
//              and, unavoidably on Android, also blocks screenshots (no API redacts recents without it).
// Native protection state resets on app restart, so the host re-applies the persisted value on mount.
export async function applyPrivacyScreen(enabled: boolean): Promise<void> {
	if (Platform.OS === "ios") {
		if (enabled) {
			await ScreenCapture.enableAppSwitcherProtectionAsync(PRIVACY_SCREEN_BLUR_INTENSITY)
		} else {
			await ScreenCapture.disableAppSwitcherProtectionAsync()
		}

		return
	}

	if (enabled) {
		await ScreenCapture.preventScreenCaptureAsync()
	} else {
		await ScreenCapture.allowScreenCaptureAsync()
	}
}
