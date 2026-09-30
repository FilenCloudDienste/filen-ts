import * as Haptics from "expo-haptics"
import cache from "@/lib/cache"
import logger from "@/lib/logger"
import { HAPTICS_ENABLED_SECURE_STORE_KEY, DEFAULT_HAPTICS_ENABLED } from "@/constants"

/**
 * Non-reactive gate for the global tap haptic.
 *
 * The selection haptic fires from the root `PressablesConfig.onPress` (routes/_layout.tsx), so
 * reading the enabled preference there with `useSecureStore` would re-render the ENTIRE app tree on
 * every toggle. Instead `selection()` reads secureStore's synchronous in-memory mirror
 * (cache.secureStore) per tap; before secureStore init the default (ON) applies.
 */
const haptics = {
	/**
	 * Fire the tap haptic when enabled. Uses the Light impact (a short, crisp tap) rather than the
	 * selection haptic, which users reported as feeling delayed and lingering past the tap.
	 * Synchronous + never throws (failures are logged).
	 */
	selection(): void {
		const value = cache.secureStore.get(HAPTICS_ENABLED_SECURE_STORE_KEY)

		if (!(typeof value === "boolean" ? value : DEFAULT_HAPTICS_ENABLED)) {
			return
		}

		Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(e => logger.warn("haptics", "impactAsync failed", { error: e }))
	}
}

export default haptics
