import { ConfigPlugin } from "@expo/config-plugins"
import { withAppBuildGradle } from "@expo/config-plugins/build/plugins/android-plugins"
import fs from "node:fs"
import path from "node:path"

// Pure gradle transform, exported for tests: insert the release signingConfig and point ONLY
// buildTypes.release at it. The Expo template sets `signingConfig signingConfigs.debug` in BOTH
// buildTypes (release deliberately ships debug-signed with a caution comment) — a global replace
// would rewire the debug buildType to the production keystore too, producing debuggable APKs
// carrying the release signature.
export function applyReleaseSigning(
	contents: string,
	credentials: {
		keystorePassword: string
		keyAlias: string
		keyPassword: string
	}
): string {
	const releaseSigningConfig = `
			release {
				storeFile file('release.keystore')
				storePassword '${credentials.keystorePassword}'
				keyAlias '${credentials.keyAlias}'
				keyPassword '${credentials.keyPassword}'
			}`

	// Find the signingConfigs block and add the release config after debug
	const signingConfigsRegex = /(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\}\s*)/
	const match = contents.match(signingConfigsRegex)

	if (!match) {
		// Without this insertion the replace below would point buildTypes.release at a signingConfigs.release that does not exist
		throw new Error(
			"Unable to locate the signingConfigs block in android/app/build.gradle. The Expo prebuild template may have changed."
		)
	}

	contents = contents.replace(signingConfigsRegex, match[1] + releaseSigningConfig)

	// Scoped to the release buildType: the first `signingConfig signingConfigs.debug` AFTER the
	// first `release {` inside the buildTypes block (the debug buildType's own line precedes any
	// `release {`, so it can never be the target).
	const releaseBuildTypeRegex = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/
	const replaced = contents.replace(releaseBuildTypeRegex, "$1signingConfig signingConfigs.release")

	if (replaced === contents) {
		throw new Error(
			"Unable to locate buildTypes.release's signingConfig line in android/app/build.gradle. The Expo prebuild template may have changed."
		)
	}

	return replaced
}

const withAndroidSigning: ConfigPlugin = config => {
	return withAppBuildGradle(config, config => {
		const { modResults } = config
		const credentialsFile = path.join(config.modRequest.platformProjectRoot, "..", "credentials.json")

		if (fs.existsSync(credentialsFile)) {
			const credentials = JSON.parse(fs.readFileSync(credentialsFile, "utf-8"))
			const { keystoreBase64, keystorePassword, keyAlias, keyPassword } = credentials.android?.keystore || {}

			if (!keystoreBase64 || !keystorePassword || !keyAlias || !keyPassword) {
				throw new Error("Incomplete Android keystore credentials. Please check your credentials.json file.")
			}

			console.log("Adding Android signing configuration...")

			const keystoreDestination = path.join(config.modRequest.platformProjectRoot, "app", "release.keystore")

			if (!fs.existsSync(keystoreDestination)) {
				fs.writeFileSync(keystoreDestination, Buffer.from(keystoreBase64, "base64"))
			}

			modResults.contents = applyReleaseSigning(modResults.contents, {
				keystorePassword,
				keyAlias,
				keyPassword
			})
		} else {
			console.log("No Android signing configuration found. Using debug signing config.")

			// Replace signingConfig in buildTypes.release
			modResults.contents = modResults.contents
				.split("signingConfig signingConfigs.release")
				.join("signingConfig signingConfigs.debug")
		}

		return config
	})
}

export default withAndroidSigning
