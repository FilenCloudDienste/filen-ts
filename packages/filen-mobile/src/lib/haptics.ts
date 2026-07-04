import * as Haptics from "expo-haptics"
import secureStore from "@/lib/secureStore"
import events from "@/lib/events"
import logger from "@/lib/logger"
import { HAPTICS_ENABLED_SECURE_STORE_KEY, DEFAULT_HAPTICS_ENABLED } from "@/constants"

/**
 * Non-reactive gate for the global tap haptic.
 *
 * The selection haptic fires from the root `PressablesConfig.onPress` (routes/_layout.tsx), so
 * reading the enabled preference there with `useSecureStore` would re-render the ENTIRE app tree on
 * every toggle — and again on the async hydration. Instead this singleton caches the boolean in
 * memory: it hydrates from secureStore once and keeps the cache current via the
 * secureStoreChange/Remove/Clear events that every secureStore write emits. `onPress` then does a
 * synchronous field read (`haptics.selection()`) and the layout never subscribes to anything.
 *
 * Process-lifetime singleton (like the other silent lib singletons); the event subscriptions are
 * intentionally never removed.
 */
class HapticsManager {
	private enabled: boolean = DEFAULT_HAPTICS_ENABLED

	constructor() {
		// Best-effort initial hydration. secureStore.init() also re-emits a secureStoreChange for
		// every stored key, so even if this read races init the subscription below still catches the
		// persisted value. Until it resolves the default (ON) applies — a few boot-time taps at most.
		secureStore
			.get<boolean>(HAPTICS_ENABLED_SECURE_STORE_KEY)
			.then(value => {
				if (typeof value === "boolean") {
					this.enabled = value
				}
			})
			.catch(e => logger.warn("haptics", "failed to read haptics preference", { error: e }))

		events.subscribe("secureStoreChange", ({ key, value }) => {
			if (key === HAPTICS_ENABLED_SECURE_STORE_KEY && typeof value === "boolean") {
				this.enabled = value
			}
		})

		events.subscribe("secureStoreRemove", ({ key }) => {
			if (key === HAPTICS_ENABLED_SECURE_STORE_KEY) {
				this.enabled = DEFAULT_HAPTICS_ENABLED
			}
		})

		events.subscribe("secureStoreClear", () => {
			this.enabled = DEFAULT_HAPTICS_ENABLED
		})
	}

	public isEnabled(): boolean {
		return this.enabled
	}

	/**
	 * Fire the tap haptic when enabled. Uses the Light impact (a short, crisp tap) rather than the
	 * selection haptic, which users reported as feeling delayed and lingering past the tap.
	 * Synchronous + never throws (failures are logged).
	 */
	public selection(): void {
		if (!this.enabled) {
			return
		}

		Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(e => logger.warn("haptics", "impactAsync failed", { error: e }))
	}
}

export default new HapticsManager()
