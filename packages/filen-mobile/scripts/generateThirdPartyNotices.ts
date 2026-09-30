import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import {
	describedNotice,
	listInstalledNpm,
	poolLicenseTexts,
	readJson,
	repositoryOf,
	spdxOf,
	type CollectedNotice,
	type InstalledNpmPackage,
	type NoticeEntry
} from "@filen/shared/tooling"

/**
 * Emits the third-party attribution payload the Open Source screen renders.
 *
 * MIT, BSD and Apache-2.0 all require the license text AND the copyright notice to accompany the
 * distribution, so listing package names and SPDX ids would not discharge the obligation — the text
 * has to ship inside the app.
 *
 * Shipping it verbatim per package would be ~1.8 MB, because an MIT file is identical everywhere
 * except its copyright line. So the copyright lines are lifted out and stored per package, and what
 * remains — the boilerplate — is deduplicated across every package that shares it. Nothing is
 * summarised or paraphrased; the rendered notice is copyright line plus verbatim boilerplate.
 *
 * A package whose license file cannot be found keeps its SPDX id and repository URL and points at no
 * text. Substituting another package's text of the same license would attribute the wrong copyright
 * holder, which is worse than an honest gap.
 *
 * Covers all four ecosystems that end up in the binaries: the npm tree (minus devDependencies, which
 * are build tooling and never reach a device), the Rust crates the SDK is compiled from, the pods
 * CocoaPods vendors into the iOS build, and the Maven modules Gradle links into the Android one.
 *
 * Every one of those is read from a local build artifact or package cache, so this is a release act
 * rather than a CI step: it must run on a machine that has installed dependencies, built filen-rs, run
 * pod install, and assembled an Android release. A missing input throws rather than quietly emitting a
 * payload that omits an ecosystem.
 *
 * Run: pnpm run notices
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, "..")
const OUTPUT = join(packageRoot, "src", "features", "settings", "thirdPartyNotices.generated.ts")

const ECOSYSTEMS = ["npm", "rust", "pod", "gradle"] as const

type Ecosystem = (typeof ECOSYSTEMS)[number]

type Collected = CollectedNotice<Ecosystem>

/**
 * Highest version first; a release outranks its own prereleases. Leading numeric segments are compared
 * as numbers so 10.4.3 outranks 5.1.1, which a plain string compare gets backwards; equal or
 * non-numeric segments fall back to a string compare, which only has to be deterministic.
 */
function compareVersionsDescending(left: string, right: string): number {
	const leftParts = left.split(".")
	const rightParts = right.split(".")

	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const leftPart = leftParts[index] ?? ""
		const rightPart = rightParts[index] ?? ""

		if (leftPart === rightPart) {
			continue
		}

		const leftNumber = Number.parseInt(leftPart, 10)
		const rightNumber = Number.parseInt(rightPart, 10)

		if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
			if (leftNumber !== rightNumber) {
				return rightNumber - leftNumber
			}

			// Same number, one side carrying a `-` suffix: that side is a prerelease of the other, so it ranks lower.
			const leftPrerelease = leftPart.includes("-")
			const rightPrerelease = rightPart.includes("-")

			if (leftPrerelease !== rightPrerelease) {
				return leftPrerelease ? 1 : -1
			}
		}

		return leftPart < rightPart ? 1 : -1
	}

	return 0
}

/**
 * The installed npm packages, grouped by name with the highest installed version leading each name.
 * Which copy of a multi-version name gets described must not depend on pnpm's report order: the
 * "first described wins" dedupe in collectNpm keeps the leader.
 */
function installedNpm(): InstalledNpmPackage[] {
	const installed = listInstalledNpm("@filen/mobile", packageRoot)
	const byName = new Map<string, InstalledNpmPackage[]>()

	for (const entry of installed) {
		const bucket = byName.get(entry.name)

		if (bucket === undefined) {
			byName.set(entry.name, [entry])

			continue
		}

		bucket.push(entry)
	}

	for (const bucket of byName.values()) {
		bucket.sort((left, right) => compareVersionsDescending(left.version, right.version))
	}

	return [...byName.values()].flat()
}

function collectNpm(): Collected[] {
	const seen = new Set<string>()
	const entries: Collected[] = []

	for (const { name, version, dir } of installedNpm()) {
		if (seen.has(name) || dir === null) {
			continue
		}

		const manifest = readJson(join(dir, "package.json"))

		// Marked seen only once actually described: a name can be reported at several paths, and claiming
		// it on the first would drop the copy that IS readable.
		if (!manifest) {
			continue
		}

		seen.add(name)

		entries.push(
			describedNotice({
				name,
				version: typeof manifest["version"] === "string" ? manifest["version"] : version,
				license: spdxOf(manifest["license"] ?? manifest["licenses"]),
				ecosystem: "npm",
				dir,
				repository: repositoryOf(manifest["repository"])
			})
		)
	}

	return entries
}

function crateSourceRoots(): string[] {
	const base = join(homedir(), ".cargo", "registry", "src")

	if (!existsSync(base)) {
		return []
	}

	return readdirSync(base).map(entry => join(base, entry))
}

function collectRust(): Collected[] {
	const lockPath = join(packageRoot, "filen-rs", "Cargo.lock")

	if (!existsSync(lockPath)) {
		throw new Error("filen-rs/Cargo.lock is missing — initialise the submodule before generating notices")
	}

	const lock = readFileSync(lockPath, "utf8")
	const roots = crateSourceRoots()
	const entries: Collected[] = []

	const matches = lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g)

	for (const match of matches) {
		const [, name, version, source] = match

		// No `source` means a workspace member — Filen's own code, not a third party.
		if (!source || !name || !version) {
			continue
		}

		const dir = roots.map(root => join(root, `${name}-${version}`)).find(existsSync) ?? null
		const manifest = dir && existsSync(join(dir, "Cargo.toml")) ? readFileSync(join(dir, "Cargo.toml"), "utf8") : ""
		entries.push(
			describedNotice({
				name,
				version,
				license: /^\s*license\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? "UNKNOWN",
				ecosystem: "rust",
				dir,
				repository: /^\s*repository\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null
			})
		)
	}

	return entries
}

/**
 * A pod's own metadata, from whichever spec cache holds it.
 *
 * Pods installed from a podspec keep theirs in the project (Local Podspecs); pods pulled from the CDN
 * keep theirs in the shared CocoaPods cache. Neither covers the other, so both are consulted.
 */
function podSpec(name: string): { license?: unknown; homepage?: unknown; source?: { git?: unknown } } | null {
	const local = readJson(join(packageRoot, "ios", "Pods", "Local Podspecs", `${name}.podspec.json`))

	if (local) {
		return local
	}

	const cached = join(homedir(), "Library", "Caches", "CocoaPods", "Pods", "Specs", "Release", name)

	if (!existsSync(cached)) {
		return null
	}

	// Cached spec names carry a version and a hash, and several versions may be present. Any of them
	// describes the same project's license, which is all that is read from here.
	const spec = readdirSync(cached).find(entry => entry.endsWith(".podspec.json"))

	return spec === undefined ? null : readJson(join(cached, spec))
}

/**
 * The pods that ship as compiled source rather than as an npm package.
 *
 * CocoaPods only copies a pod into ios/Pods when it comes from the CDN or from a podspec; a pod backed
 * by a `:path:` into node_modules is referenced where it lies and is already described as an npm
 * package. So the directories that exist here ARE the residue — the CDN pods plus the vendored C++
 * libraries React Native downloads (boost, glog, folly, double-conversion, fmt), whose licenses appear
 * nowhere in the npm tree.
 */
function collectPods(): Collected[] {
	const lockPath = join(packageRoot, "ios", "Podfile.lock")
	const podsRoot = join(packageRoot, "ios", "Pods")

	if (!existsSync(lockPath) || !existsSync(podsRoot)) {
		throw new Error("ios/Podfile.lock or ios/Pods is missing — run prebuild + pod install before generating notices")
	}

	const lock = readFileSync(lockPath, "utf8")
	const installed = lock.split("PODS:")[1]?.split("\nDEPENDENCIES:")[0] ?? ""
	const entries: Collected[] = []
	const seen = new Set<string>()

	// Subspecs (SDWebImage/Core) share their parent's directory and license, so each collapses onto its
	// parent and the parent is described once. They cannot simply be skipped: libavif is installed only
	// as libavif/core and libavif/libdav1d, and matching bare names alone would drop it entirely.
	for (const [, subspec, version] of installed.matchAll(/\n {2}- "?([A-Za-z0-9_.+\-/]+)"? \(([^)]+)\)/g)) {
		const name = subspec?.split("/")[0]

		if (name === undefined || version === undefined || seen.has(name) || !existsSync(join(podsRoot, name))) {
			continue
		}

		seen.add(name)

		const spec = podSpec(name)
		const license = spdxOf(spec?.license) === "UNKNOWN" ? spdxOf((spec?.license as { type?: unknown })?.type) : spdxOf(spec?.license)

		entries.push(
			describedNotice({
				name,
				version,
				license,
				ecosystem: "pod",
				dir: join(podsRoot, name),
				repository: repositoryOf(spec?.homepage) ?? repositoryOf(spec?.source?.git)
			})
		)
	}

	return entries
}

/**
 * The Maven modules linked into the Android build.
 *
 * Read from the dependency manifest AGP writes at assemble time rather than by resolving the graph
 * here, so this needs no Gradle run — but it does need a release build to have happened. Licenses come
 * from each module's POM in the Gradle cache, which declares one for 240 of the 248 modules.
 */
function collectGradle(): Collected[] {
	const manifestPath = join(packageRoot, "android", "app", "build", "outputs", "sdk-dependencies", "release", "sdkDependencies.txt")
	const cache = join(homedir(), ".gradle", "caches", "modules-2", "files-2.1")

	if (!existsSync(manifestPath) || !existsSync(cache)) {
		throw new Error("android sdkDependencies.txt or the Gradle cache is missing — run a release assemble before generating notices")
	}

	const manifest = readFileSync(manifestPath, "utf8")
	const entries: Collected[] = []

	for (const [, group, artifact, version] of manifest.matchAll(
		/maven_library \{\s*groupId: "([^"]+)"\s*artifactId: "([^"]+)"\s*version: "([^"]+)"/g
	)) {
		if (group === undefined || artifact === undefined || version === undefined) {
			continue
		}

		const moduleRoot = join(cache, group, artifact, version)

		// The cache interposes a hash directory between the version and the files, and there is one per
		// artifact kind (pom, aar, sources). The pom is what carries the licence declaration.
		const pom = existsSync(moduleRoot)
			? readdirSync(moduleRoot)
					.map(hash => join(moduleRoot, hash, `${artifact}-${version}.pom`))
					.filter(existsSync)
					.map(path => readFileSync(path, "utf8"))[0]
			: undefined

		const declared = pom === undefined ? undefined : /<licenses>([\s\S]*?)<\/licenses>/.exec(pom)?.[1]

		entries.push({
			name: `${group}:${artifact}`,
			version,
			license: (declared === undefined ? undefined : /<name>([^<]+)<\/name>/.exec(declared)?.[1]?.trim()) ?? "UNKNOWN",
			ecosystem: "gradle",
			copyright: [],
			// The project URL, taken before the licence block so a licence's own <url> cannot be mistaken
			// for it.
			repository: (pom === undefined ? undefined : /<url>([^<]+)<\/url>/.exec(pom.split("<licenses>")[0] ?? "")?.[1]?.trim()) ?? null,
			texts: [],
			// A Maven artifact almost never embeds its licence — 5 of 248 do — so the text comes from the
			// canonical-terms pass below rather than from disk.
			terms: []
		})
	}

	return entries
}

const collected = [...collectNpm(), ...collectRust(), ...collectPods(), ...collectGradle()]

const texts = poolLicenseTexts(collected)

const notices: NoticeEntry<Ecosystem>[] = collected
	.map(({ terms: _terms, ...entry }) => entry)
	.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const withText = notices.filter(entry => entry.texts.length > 0).length

const output = `// GENERATED by scripts/generateThirdPartyNotices.ts — do not edit.
//
// Attribution for everything compiled or bundled into the app: the npm tree minus devDependencies,
// plus the Rust crates the SDK is built from. License terms are deduplicated across packages and the
// copyright lines kept per package, so a rendered notice is that package's copyright followed by the
// verbatim terms. An empty \`texts\` means no license file shipped with the package; its SPDX id and
// repository are given instead rather than borrowing another package's copyright. More than one entry
// means the declared license is a conjunction — every text applies.

export type ThirdPartyNotice = {
	name: string
	version: string
	license: string
	ecosystem: ${ECOSYSTEMS.map(ecosystem => JSON.stringify(ecosystem)).join(" | ")}
	copyright: string[]
	repository: string | null
	texts: number[]
}

export const LICENSE_TEXTS: readonly string[] = ${JSON.stringify(texts, null, 0)}

export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = ${JSON.stringify(notices, null, 0)}
`

writeFileSync(OUTPUT, output, "utf8")

const perEcosystem = ECOSYSTEMS.map(ecosystem => {
	const rows = notices.filter(entry => entry.ecosystem === ecosystem)

	return `  ${`${ecosystem}:`.padEnd(15)} ${String(rows.length).padStart(4)}  (${rows.filter(entry => entry.texts.length > 0).length} with text)`
})

console.log(
	[
		`third-party notices -> ${OUTPUT}`,
		...perEcosystem,
		`  total:          ${notices.length}`,
		`  license texts:  ${texts.length} unique (deduplicated)`,
		`  with text:      ${withText}`,
		`  without text:   ${notices.length - withText}`,
		`  payload:        ${(Buffer.byteLength(output, "utf8") / 1024).toFixed(0)} KB`
	].join("\n")
)
