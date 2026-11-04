import { type ConfigPlugin, withAppBuildGradle, withDangerousMod, withProjectBuildGradle } from "expo/config-plugins"
import fs from "node:fs"
import path from "node:path"
import {
	assertVerifierVersions,
	RUSTLS_PLATFORM_VERIFIER,
	RUSTLS_PLATFORM_VERIFIER_COORDINATE,
	verifierLockSources
} from "./rustlsPlatformVerifier"

// Android wiring for rustls-platform-verifier's Kotlin half (the AAR the Rust TLS verifier calls through
// JNI): upstream's Maven repository, the dependency, an R8 keep rule, and a check that the AAR matches
// the crate version both Rust builds pin. The network security config that keeps its CRL fetches
// working is withAndroidNetworkSecurityConfig.ts.

const MARKER = "// withAndroidRustlsPlatformVerifier"
const PROGUARD_MARKER = "# withAndroidRustlsPlatformVerifier"
const ALLPROJECTS_REPOSITORIES = /^([ \t]*)allprojects\s*\{\s*\n([ \t]*)repositories\s*\{[ \t]*$/m

// Upstream's rule: R8 cannot see the JNI calls into these classes and would strip them.
export const PROGUARD_RULE = "-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }"

/** Adds upstream's Maven repository to allprojects.repositories, scoped to the org.rustls group. Idempotent. */
export function addRustlsMavenRepository(contents: string): string {
	if (contents.includes(MARKER)) {
		return contents
	}

	const match = contents.match(ALLPROJECTS_REPOSITORIES)

	if (!match || match.index === undefined) {
		throw new Error("Unable to locate allprojects.repositories in android/build.gradle. The Expo prebuild template may have changed.")
	}

	const indent = `${match[2] ?? ""}  `
	const snippet = [
		`${indent}${MARKER}`,
		`${indent}maven {`,
		`${indent}  url '${RUSTLS_PLATFORM_VERIFIER.repository}'`,
		`${indent}  content {`,
		`${indent}    includeGroup '${RUSTLS_PLATFORM_VERIFIER.group}'`,
		`${indent}  }`,
		`${indent}}`
	].join("\n")
	const end = match.index + match[0].length

	return `${contents.slice(0, end)}\n${snippet}${contents.slice(end)}`
}

/** Adds the pinned AAR to the app module's dependencies. Idempotent. */
export function addRustlsDependency(contents: string): string {
	if (contents.includes(MARKER)) {
		return contents
	}

	return `${contents}
dependencies {
	${MARKER}
	implementation '${RUSTLS_PLATFORM_VERIFIER_COORDINATE}'
}
`
}

/** Appends the keep rule to app/proguard-rules.pro. Idempotent. */
export function addRustlsProguardRule(contents: string): string {
	if (contents.includes(PROGUARD_MARKER)) {
		return contents
	}

	return `${contents.replace(/\s*$/, "\n")}\n${PROGUARD_MARKER}\n${PROGUARD_RULE}\n`
}

const withAndroidRustlsPlatformVerifier: ConfigPlugin = config => {
	config = withProjectBuildGradle(config, config => {
		config.modResults.contents = addRustlsMavenRepository(config.modResults.contents)

		return config
	})

	config = withAppBuildGradle(config, config => {
		config.modResults.contents = addRustlsDependency(config.modResults.contents)

		return config
	})

	return withDangerousMod(config, [
		"android",
		async config => {
			assertVerifierVersions(verifierLockSources(config.modRequest.projectRoot))

			const proguardPath = path.join(config.modRequest.platformProjectRoot, "app", "proguard-rules.pro")
			const current = fs.existsSync(proguardPath) ? fs.readFileSync(proguardPath, "utf8") : ""

			fs.writeFileSync(proguardPath, addRustlsProguardRule(current))

			return config
		}
	])
}

export default withAndroidRustlsPlatformVerifier
