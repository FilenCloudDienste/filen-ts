import { describe, it, expect } from "vitest"
// plugins/ sits outside src/, so no "@/" alias — relative import is fine in tests.
import { applyReleaseSigning } from "../../plugins/withAndroidSigning"

// Mirrors the Expo prebuild template's android/app/build.gradle shape: signingConfigs with a
// debug config, then buildTypes where BOTH debug and release point at signingConfigs.debug
// (release deliberately ships debug-signed until a real keystore is wired in).
const TEMPLATE = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            shrinkResources true
            minifyEnabled true
        }
    }
}
`

const CREDENTIALS = {
	keystorePassword: "store-pass",
	keyAlias: "alias",
	keyPassword: "key-pass"
}

describe("applyReleaseSigning", () => {
	it("points ONLY buildTypes.release at the release keystore — debug keeps the debug keystore", () => {
		const out = applyReleaseSigning(TEMPLATE, CREDENTIALS)

		// The release signing config was inserted.
		expect(out).toContain("storeFile file('release.keystore')")
		expect(out).toContain("storePassword 'store-pass'")

		// Exactly one buildType line was rewritten: release → signingConfigs.release, while the
		// debug buildType (and the signingConfigs.debug DEFINITION block) stay untouched. The
		// old global replace rewrote both buildTypes, producing debuggable APKs carrying the
		// production signature.
		const debugBuildType = out.match(/buildTypes\s*\{[\s\S]*?debug\s*\{([\s\S]*?)\}/)?.[1] ?? ""
		const releaseBuildType = out.match(/release\s*\{[\s\S]*?signingConfig signingConfigs\.(\w+)/g) ?? []

		expect(debugBuildType).toContain("signingConfig signingConfigs.debug")
		expect(out.match(/signingConfig signingConfigs\.release/g)).toHaveLength(1)
		expect(releaseBuildType.join("\n")).toContain("signingConfigs.release")
	})

	it("throws when the signingConfigs block is missing (template shape changed)", () => {
		expect(() => applyReleaseSigning("android { buildTypes { release { } } }", CREDENTIALS)).toThrow(/signingConfigs block/)
	})

	it("throws when buildTypes.release has no signingConfig line to rewrite", () => {
		const noReleaseLine = TEMPLATE.replace(
			"            signingConfig signingConfigs.debug\n            shrinkResources",
			"            shrinkResources"
		)

		expect(() => applyReleaseSigning(noReleaseLine, CREDENTIALS)).toThrow(/buildTypes\.release/)
	})
})
