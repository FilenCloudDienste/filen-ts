import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import JSZip from "jszip"

// The Kotlin half of rustls-platform-verifier, which the sdk-rs and filen-mobile-native-cache libraries
// call through JNI on Android. Its version must equal the rustls-platform-verifier-android crate both
// Rust builds pin (assertVerifierVersions). Fetched from upstream's Maven repository; the plugin checks
// the download against this sha256, so a bump changes `version` and `sha256` together.
export const RUSTLS_PLATFORM_VERIFIER = {
	group: "org.rustls",
	artifact: "rustls-platform-verifier",
	version: "0.2.0",
	sha256: "aa021794230fbc2f0be355999e2cf67398dd563de066a2e17001ffbd0b69101b",
	repository: "https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/",
	crate: "rustls-platform-verifier-android"
} as const

export const RUSTLS_PLATFORM_VERIFIER_COORDINATE = `${RUSTLS_PLATFORM_VERIFIER.group}:${RUSTLS_PLATFORM_VERIFIER.artifact}:${RUSTLS_PLATFORM_VERIFIER.version}`

// The library's own cleartext allowlist for CRL fetches, which the app's network_security_config.xml
// replaces (an app resource overrides a library resource of the same name).
const AAR_NETWORK_SECURITY_CONFIG = "res/xml/network_security_config.xml"

export function aarFileName(): string {
	return `${RUSTLS_PLATFORM_VERIFIER.artifact}-${RUSTLS_PLATFORM_VERIFIER.version}.aar`
}

export function aarUrl(): string {
	return `${RUSTLS_PLATFORM_VERIFIER.repository}${RUSTLS_PLATFORM_VERIFIER.group.replace(/\./g, "/")}/${RUSTLS_PLATFORM_VERIFIER.artifact}/${RUSTLS_PLATFORM_VERIFIER.version}/${aarFileName()}`
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

/**
 * The pinned AAR's bytes: from `<projectRoot>/node_modules/.cache/` when a verified copy is there, else
 * downloaded and cached. Throws on a hash mismatch, so a changed upstream artifact never reaches a build.
 */
export async function loadRustlsPlatformVerifierAar(projectRoot: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
	const cachePath = path.join(projectRoot, "node_modules", ".cache", RUSTLS_PLATFORM_VERIFIER.artifact, aarFileName())

	if (fs.existsSync(cachePath)) {
		const cached = fs.readFileSync(cachePath)

		if (sha256(cached) === RUSTLS_PLATFORM_VERIFIER.sha256) {
			return cached
		}
	}

	const response = await fetchImpl(aarUrl())

	if (!response.ok) {
		throw new Error(`Downloading ${aarUrl()} failed: HTTP ${response.status}`)
	}

	const bytes = Buffer.from(await response.arrayBuffer())
	const actual = sha256(bytes)

	if (actual !== RUSTLS_PLATFORM_VERIFIER.sha256) {
		throw new Error(
			`${RUSTLS_PLATFORM_VERIFIER_COORDINATE} has sha256 ${actual}, expected ${RUSTLS_PLATFORM_VERIFIER.sha256}. Update RUSTLS_PLATFORM_VERIFIER only together with its version.`
		)
	}

	fs.mkdirSync(path.dirname(cachePath), { recursive: true })

	const tmpPath = `${cachePath}.${process.pid}.tmp`

	fs.writeFileSync(tmpPath, bytes)
	fs.renameSync(tmpPath, cachePath)

	return bytes
}

export async function extractAarNetworkSecurityConfig(aar: Uint8Array): Promise<string> {
	const zip = await JSZip.loadAsync(aar)
	const entry = zip.file(AAR_NETWORK_SECURITY_CONFIG)

	if (!entry) {
		throw new Error(`${RUSTLS_PLATFORM_VERIFIER_COORDINATE} has no ${AAR_NETWORK_SECURITY_CONFIG}`)
	}

	return await entry.async("string")
}

export type CleartextDomain = {
	host: string
	includeSubdomains: boolean
}

const DOMAIN_CONFIG = /<domain-config\b([^>]*)>([\s\S]*?)<\/domain-config>/g
const DOMAIN = /<domain\b([^>]*)>\s*([^<\s]+)\s*<\/domain>/g

/** The domains of every `cleartextTrafficPermitted="true"` domain-config in a network security config. */
export function parseCleartextDomains(xml: string): CleartextDomain[] {
	const domains: CleartextDomain[] = []

	for (const [, attributes, body] of xml.matchAll(DOMAIN_CONFIG)) {
		if (!/cleartextTrafficPermitted\s*=\s*"true"/.test(attributes ?? "")) {
			continue
		}

		for (const [, domainAttributes, host] of (body ?? "").matchAll(DOMAIN)) {
			if (host) {
				domains.push({
					host: host.toLowerCase(),
					includeSubdomains: /includeSubdomains\s*=\s*"true"/.test(domainAttributes ?? "")
				})
			}
		}
	}

	return domains
}

// Let's Encrypt, which issues Filen's certificates, names a new CRL host per intermediate; allowing the
// whole zone keeps a rotated intermediate from looking revoked before the AAR's list catches up.
export const ALWAYS_ALLOWED_CRL_DOMAINS: CleartextDomain[] = [{ host: "lencr.org", includeSubdomains: true }]

/**
 * The app's network_security_config.xml: the app's own cleartext hosts, plus the verifier AAR's CRL
 * hosts and ALWAYS_ALLOWED_CRL_DOMAINS, so the app's file does not silently drop the AAR's allowlist
 * (without it every CRL fetch is refused and every certificate looks revoked). Android rejects a
 * config that lists a domain twice, so later groups skip hosts an earlier one already lists.
 */
export function buildNetworkSecurityConfig({
	appCleartextHosts,
	aarNetworkSecurityConfig
}: {
	appCleartextHosts: readonly string[]
	aarNetworkSecurityConfig: string
}): string {
	const aarDomains = parseCleartextDomains(aarNetworkSecurityConfig)

	if (aarDomains.length === 0) {
		throw new Error(`No cleartext CRL domains found in ${RUSTLS_PLATFORM_VERIFIER_COORDINATE}'s ${AAR_NETWORK_SECURITY_CONFIG}`)
	}

	const seen = new Set<string>()
	const group = (domains: CleartextDomain[]): string[] =>
		domains
			.filter(domain => {
				if (seen.has(domain.host)) {
					return false
				}

				seen.add(domain.host)

				return true
			})
			.map(domain => `\t\t<domain includeSubdomains="${domain.includeSubdomains}">${domain.host}</domain>`)

	const appLines = group(appCleartextHosts.map(host => ({ host: host.toLowerCase(), includeSubdomains: true })))
	const crlLines = group([...ALWAYS_ALLOWED_CRL_DOMAINS, ...aarDomains])

	return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by plugins/withAndroidNetworkSecurityConfig.ts; do not edit. -->
<network-security-config>
	<domain-config cleartextTrafficPermitted="true">
${appLines.join("\n")}
	</domain-config>
	<!-- CRL hosts for the platform TLS verifier: ${RUSTLS_PLATFORM_VERIFIER_COORDINATE}'s ${AAR_NETWORK_SECURITY_CONFIG} plus ${ALWAYS_ALLOWED_CRL_DOMAINS.map(domain => domain.host).join(", ")} -->
	<domain-config cleartextTrafficPermitted="true">
${crlLines.join("\n")}
	</domain-config>
</network-security-config>
`
}

/** Whether `host` is allowed by one of `domains` (exact, or a subdomain of an includeSubdomains entry). */
export function isHostCovered(host: string, domains: readonly CleartextDomain[]): boolean {
	const normalized = host.toLowerCase()

	return domains.some(domain => normalized === domain.host || (domain.includeSubdomains && normalized.endsWith(`.${domain.host}`)))
}

/** The version a Cargo.lock pins for `crate`, or null when the lock does not contain it. */
export function cargoLockVersion(lock: string, crate: string): string | null {
	for (const block of lock.split(/^\[\[package\]\]\s*$/m)) {
		const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1]

		if (name === crate) {
			return block.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null
		}
	}

	return null
}

export type VerifierLockSource = {
	// Which Rust build the lock belongs to, for the error message.
	label: string
	path: string
	// The lock's contents, or null when the file does not exist.
	lock: string | null
}

/**
 * Throws unless every Rust build that links rustls-platform-verifier pins the same
 * rustls-platform-verifier-android version as the AAR: a different Kotlin half fails at runtime.
 */
export function assertVerifierVersions(
	sources: readonly VerifierLockSource[],
	aarVersion: string = RUSTLS_PLATFORM_VERIFIER.version
): void {
	const problems: string[] = []

	for (const source of sources) {
		if (source.lock === null) {
			problems.push(`${source.label}: ${source.path} not found`)

			continue
		}

		const pinned = cargoLockVersion(source.lock, RUSTLS_PLATFORM_VERIFIER.crate)

		if (pinned === null) {
			problems.push(`${source.label}: ${source.path} does not pin ${RUSTLS_PLATFORM_VERIFIER.crate}`)
		} else if (pinned !== aarVersion) {
			problems.push(`${source.label}: ${source.path} pins ${RUSTLS_PLATFORM_VERIFIER.crate} ${pinned}`)
		}
	}

	if (problems.length > 0) {
		throw new Error(
			`The ${RUSTLS_PLATFORM_VERIFIER.artifact} AAR is ${aarVersion} (plugins/rustlsPlatformVerifier.ts), but:\n${problems.map(problem => `  - ${problem}`).join("\n")}`
		)
	}
}

function readIfExists(filePath: string): string | null {
	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null
}

/**
 * The two Rust builds the Android app links: the filen-rs submodule (filen-mobile-native-cache, the
 * Documents Provider) and the published @filen/sdk-rs, which ships the Cargo.lock it was built from.
 */
export function verifierLockSources(projectRoot: string): VerifierLockSource[] {
	const submoduleLock = path.join(projectRoot, "filen-rs", "Cargo.lock")
	const sdkRsLock = path.join(projectRoot, "node_modules", "@filen", "sdk-rs", "Cargo.lock")

	return [
		{ label: "filen-rs submodule", path: submoduleLock, lock: readIfExists(submoduleLock) },
		{ label: "@filen/sdk-rs", path: sdkRsLock, lock: readIfExists(sdkRsLock) }
	]
}
