import { useSecureStore } from "@/lib/secureStore"

// secureStore key for the "Privacy screen" setting. Boolean; absent/false → no redaction (the
// default — privacy screen is opt-in). Read by <PrivacyScreen> (src/components/privacyScreen.tsx) and
// written by the Security settings toggle. The redaction is platform-split: iOS uses a React
// FullWindowOverlay cover (covers modals, integrates with the system-presentation suppression);
// Android uses expo-screen-capture's FLAG_SECURE (a JS cover can't win the recents-snapshot race there) —
// see that component for the rationale.
export const PRIVACY_SCREEN_ENABLED_SECURE_STORE_KEY = "privacyScreenEnabled"

export const DEFAULT_PRIVACY_SCREEN_ENABLED = false

export function usePrivacyScreenEnabled(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
	return useSecureStore<boolean>(PRIVACY_SCREEN_ENABLED_SECURE_STORE_KEY, DEFAULT_PRIVACY_SCREEN_ENABLED)
}
