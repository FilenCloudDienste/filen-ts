import { Platform } from "react-native"
import notifee from "react-native-notify-kit"
import logger from "@/lib/logger"

/**
 * Android's power allowlist, which is what actually decides whether background sync can run.
 *
 * Android meters background work through App Standby Buckets, and the documented per-bucket limits
 * are not just a delay: in the `rare` and `restricted` buckets background job NETWORK ACCESS is
 * disabled outright, and Doze "doesn't let JobScheduler run" at all — which WorkManager (and so
 * expo-background-task, and so our whole background sync) is built on. An app the user rarely opens
 * drifts into exactly those buckets, and a backup app is by definition one the user rarely opens.
 * That is the mechanism behind "it never syncs unless I open it".
 *
 * The documented escape is the power allowlist: apps on the Doze exemption list "are exempted from
 * the App Standby Bucket-based restrictions". Only the user can grant it, from system settings.
 *
 * Deliberately routed through the settings SCREEN (Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
 * which is what notify-kit's openBatteryOptimizationSettings fires) rather than the direct-request
 * dialog: that dialog needs REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, and Play's Device and Network Abuse
 * policy treats requesting it outside a narrow set of app categories as a violation ("Apps that are
 * not eligible for allowlisting and attempt to bypass system power management"). The settings screen
 * needs no permission and no declaration, because the user makes the change themselves.
 *
 * iOS has no equivalent and no API to ask for one, so everything here no-ops there.
 *
 * Lives in lib/ rather than under features/cameraUpload despite camera upload being its only caller
 * today: what it describes is an OS constraint on the SINGLE background task, which every background
 * producer shares — the offline-files pass (settings → offline) and the offline-notes refresh are
 * throttled by exactly the same buckets. Surfacing it from the offline settings screen too is the
 * obvious next step; filing it under one feature now would just have to move then.
 */
const batteryOptimization = {
	/**
	 * Whether Android is applying battery optimization to us, i.e. we are NOT on the power allowlist.
	 *
	 * Reads `PowerManager.isIgnoringBatteryOptimizations()`, which carries no permission requirement,
	 * so this is safe to call purely to render state. Returns false on iOS and on any read failure —
	 * this only ever drives an optional hint, and a broken read must not invent a warning.
	 */
	async isRestricted(): Promise<boolean> {
		if (Platform.OS !== "android") {
			return false
		}

		try {
			return await notifee.isBatteryOptimizationEnabled()
		} catch (e) {
			logger.warn("batteryOptimization", "isBatteryOptimizationEnabled failed", { error: e })

			return false
		}
	},

	/**
	 * Opens the system battery-optimization list. Never throws: the underlying intent may not resolve
	 * on every firmware, and failing to open a settings screen must not surface as an app error.
	 */
	async openSettings(): Promise<void> {
		if (Platform.OS !== "android") {
			return
		}

		try {
			await notifee.openBatteryOptimizationSettings()
		} catch (e) {
			logger.warn("batteryOptimization", "openBatteryOptimizationSettings failed", { error: e })
		}
	}
}

export default batteryOptimization
