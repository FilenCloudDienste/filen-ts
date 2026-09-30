import { withAndroidManifest, type ConfigPlugin, AndroidConfig } from "@expo/config-plugins"

/**
 * `<application>` attributes Expo's config schema does not expose.
 *
 * `android:supportsRtl` is set to FALSE deliberately, and it is not cosmetic on React Native: RN's
 * `I18nUtil.isRTL()` is gated on `applicationHasRtlSupport()`, which reads this exact flag. Turning it
 * off makes RN report LTR from the very first launch on an RTL device — no shared-preferences round
 * trip, no mirrored first launch. None of the shipped locales is right-to-left and no screen has been
 * laid out or reviewed mirrored, so the surface an Arabic/Hebrew device used to get was never a
 * supported one. iOS has no equivalent manifest gate; src/global.ts calls I18nManager.allowRTL(false)
 * to cover it.
 */
const withAndroidApplicationAttributes: ConfigPlugin = config => {
	return withAndroidManifest(config, async config => {
		const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)

		application.$["android:largeHeap"] = "true"
		application.$["android:hardwareAccelerated"] = "true"
		application.$["android:supportsRtl"] = "false"

		const activity = application.activity?.[0]

		if (activity) {
			activity.$["android:hardwareAccelerated"] = "true"
		}

		return config
	})
}

export default withAndroidApplicationAttributes
