import { ConfigPlugin } from "@expo/config-plugins"
import { withAppBuildGradle } from "@expo/config-plugins/build/plugins/android-plugins"

type AndroidDebugSuffixOptions = {
	suffix?: string
}

/**
 * Gives debug builds their own application id (io.filen.app.debug by default) so one device can
 * hold a debug build and the Play-Store release at the same time. Without it, installing a debug
 * APK over the release one fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE (different signing key),
 * which makes on-device debugging impossible without uninstalling the real app first.
 *
 * The provider authority is a `${applicationId}` manifest placeholder (see withAndroidRustBuild)
 * and FilenDocumentsProvider derives AUTHORITY from the package name at runtime, so both follow
 * the suffix automatically — otherwise the two installs would collide on the provider name
 * instead (INSTALL_FAILED_CONFLICTING_PROVIDER).
 */
const withAndroidDebugSuffix: ConfigPlugin<AndroidDebugSuffixOptions> = (config, options = {}) => {
	const suffix = options.suffix || ".debug"

	return withAppBuildGradle(config, config => {
		const contents = config.modResults.contents

		if (contents.includes("applicationIdSuffix")) {
			return config
		}

		// Anchor on the debug buildType's signingConfig line — the only one inside `debug {`.
		const anchor = "        debug {\n            signingConfig signingConfigs.debug\n        }"

		if (!contents.includes(anchor)) {
			throw new Error(
				"withAndroidDebugSuffix: could not find the debug buildType block in app/build.gradle; the template changed and this plugin needs updating"
			)
		}

		// React Native's BlobProvider takes its authority from a string resource, which cannot
		// hold a ${applicationId} placeholder — so override the resource for debug builds, or the
		// two installs collide on io.filen.app.blobs. Nothing reads this literal; RN resolves it
		// through R.string.blob_provider_authority.
		const blobAuthority = `${config.android?.package ?? "io.filen.app"}${suffix}.blobs`

		config.modResults.contents = contents.replace(
			anchor,
			`        debug {\n` +
				`            applicationIdSuffix '${suffix}'\n` +
				`            resValue "string", "blob_provider_authority", "${blobAuthority}"\n` +
				`            signingConfig signingConfigs.debug\n` +
				`        }`
		)

		return config
	})
}

export default withAndroidDebugSuffix
