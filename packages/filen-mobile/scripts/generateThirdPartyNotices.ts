import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

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
 * Run: npx tsx scripts/generateThirdPartyNotices.ts
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, "..")
const OUTPUT = join(packageRoot, "src", "features", "settings", "thirdPartyNotices.generated.ts")

type Entry = {
	name: string
	version: string
	license: string
	ecosystem: "npm" | "rust" | "pod" | "gradle"
	copyright: string[]
	repository: string | null
	/** Indices into the deduplicated boilerplate table. Empty when no license file was found. */
	texts: number[]
}

/** An entry before its terms are pooled — carries the verbatim texts the dedup pass replaces. */
type Collected = Entry & { terms: string[] }

const LICENSE_FILE = /^(LICEN[CS]E|COPYING)([-._].*)?$/i
const NOTICE_FILE = /^NOTICE([-._].*)?$/i

/** Some crates park the holder here rather than in the license file — rustix and linux-raw-sys do. */
const COPYRIGHT_FILE = /^COPYRIGHT([-._].*)?$/i

/** Lines that carry the holder rather than the terms. Lifted out so the terms can be deduplicated. */
const COPYRIGHT_LINE = /^\s*(copyright|\(c\)|©)\b/i

/**
 * Which license to elect from a dual-licensed package, lightest obligation first.
 *
 * "MIT OR Apache-2.0" is a choice offered to us, and 506 packages here offer one. Electing MIT keeps
 * the obligation to reproducing a short notice; Apache-2.0 additionally requires propagating any
 * NOTICE file and stating changes. Copyleft alternatives (MPL, GPL, LGPL) sort last so a permissive
 * option always wins when one is offered.
 *
 * Reversing this election is a one-line change to this order.
 */
const ELECTION_ORDER = ["MIT", "ISC", "BSD", "0BSD", "ZLIB", "UNLICENSE", "CC0", "APACHE", "UNICODE", "MPL"]

/**
 * Collapses an SPDX id or a license file name onto a family token, so "LICENSE-MIT", "MIT-0" and
 * "MIT" all meet. Order matters: Apache and MPL are tested before MIT because an SPDX id like
 * "Apache-2.0 WITH LLVM-exception" must not be read as anything else.
 */
function licenseFamily(value: string): string {
	const upper = value.toUpperCase()

	for (const [token, family] of [
		["APACHE", "APACHE"],
		["MPL", "MPL"],
		["UNLICENSE", "UNLICENSE"],
		["0BSD", "0BSD"],
		["BSD", "BSD"],
		["MIT", "MIT"],
		["ZLIB", "ZLIB"],
		["CC0", "CC0"],
		["ISC", "ISC"],
		["UNICODE", "UNICODE"],
		["GPL", "GPL"]
	] as const) {
		if (upper.includes(token)) {
			return family
		}
	}

	return upper
}

function rankLicense(family: string): number {
	const rank = ELECTION_ORDER.indexOf(family)

	return rank === -1 ? ELECTION_ORDER.length : rank
}

function stripOuterParens(expression: string): string {
	const trimmed = expression.trim()

	if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
		return trimmed
	}

	let depth = 0

	for (let index = 0; index < trimmed.length; index++) {
		depth += trimmed[index] === "(" ? 1 : trimmed[index] === ")" ? -1 : 0

		// The opening paren closed before the end, so the pair does not enclose the whole expression.
		if (depth === 0 && index < trimmed.length - 1) {
			return trimmed
		}
	}

	return stripOuterParens(trimmed.slice(1, -1))
}

function splitTopLevel(expression: string, separator: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0

	for (let index = 0; index < expression.length; index++) {
		depth += expression[index] === "(" ? 1 : expression[index] === ")" ? -1 : 0

		if (depth === 0 && expression.startsWith(separator, index)) {
			parts.push(expression.slice(start, index))

			index += separator.length - 1
			start = index + 1
		}
	}

	parts.push(expression.slice(start))

	return parts.map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * Splits an SPDX expression into its conjuncts — the obligations that ALL apply — each holding the
 * alternatives one may choose between.
 *
 * "MIT OR Apache-2.0" is one conjunct with two alternatives, so one text discharges it. "MIT AND
 * Zlib" is two conjuncts, so both texts must ship. Conflating them would under-attribute.
 */
function conjuncts(expression: string): string[][] {
	return splitTopLevel(stripOuterParens(expression), " AND ").map(conjunct =>
		splitTopLevel(stripOuterParens(conjunct), " OR ")
			// The legacy npm shorthand for OR, still used by 59 packages here.
			.flatMap(alternative => alternative.split("/"))
			.map(alternative => alternative.trim())
			.filter(alternative => alternative.length > 0)
	)
}

/** A nested name resolves against the same root, so every filename test reads the last segment. */
function baseName(name: string): string {
	return name.slice(name.lastIndexOf("/") + 1)
}

/**
 * The names in `dir` to consider, reaching one level down when the top level holds nothing.
 *
 * A pod is a checkout rather than a published package, so its license can sit under the upstream
 * project's own directory — libdav1d keeps its at dav1d/COPYING. Names come back joined so the reader
 * resolves them against the same root.
 */
function licenseDirectory(dir: string): string[] {
	const names = readdirSync(dir)

	if (names.some(name => LICENSE_FILE.test(baseName(name)) || NOTICE_FILE.test(baseName(name)) || COPYRIGHT_FILE.test(baseName(name)))) {
		return names
	}

	return names.flatMap(name => {
		try {
			return readdirSync(join(dir, name)).map(nested => join(name, nested))
		} catch {
			return []
		}
	})
}

/** The family we elect for an expression, independent of which files a package happens to ship. */
function electedFamily(declared: string): string | undefined {
	return (conjuncts(declared)[0] ?? []).map(licenseFamily).sort((a, b) => rankLicense(a) - rankLicense(b))[0]
}

function readIfPresent(dir: string, name: string): string | null {
	try {
		const text = readFileSync(join(dir, name), "utf8")

		return text.trim().length > 0 ? text : null
	} catch {
		return null
	}
}

/**
 * The license texts that must ship with a package: one per conjunct of its declared expression.
 *
 * Election only happens WITHIN a conjunct, where the alternatives are a genuine choice. An expression
 * containing AND ships every license file the package has instead — the obligations are cumulative, so
 * over-shipping a text is safe where guessing which ones combine is not. That path covers 7 packages.
 */
function collectLicenseTexts(dir: string, declared: string): string[] {
	if (!existsSync(dir)) {
		return []
	}

	const names = licenseDirectory(dir)
	const licenses = names.filter(name => LICENSE_FILE.test(baseName(name)))
	const groups = conjuncts(declared)
	const chosen: string[] = []

	if (groups.length > 1) {
		chosen.push(...licenses)
	} else {
		const byFamily = new Map<string, string>()

		for (const name of licenses) {
			const family = licenseFamily(baseName(name))

			// A bare LICENSE/COPYING carries no family token — it is the fallback below, not a candidate,
			// otherwise it would win the election under its own filename.
			if (family !== licenseFamily("LICENSE") && !byFamily.has(family)) {
				byFamily.set(family, name)
			}
		}

		const ranked = (groups[0] ?? []).map(licenseFamily).sort((a, b) => rankLicense(a) - rankLicense(b))

		const named = ranked.find(family => byFamily.has(family))
		const plain = licenses.find(name => /^(LICEN[CS]E|COPYING)$/i.test(baseName(name)))

		// The named file wins only if it IS the alternative we want. Otherwise the plain LICENSE is far
		// likelier to hold that alternative than a named file for a worse-ranked one: dompurify keeps
		// Apache-2.0 in LICENSE beside a LICENSE-MPL, and electing the MPL there would be backwards.
		const file =
			(named !== undefined && named === ranked[0] ? byFamily.get(named) : undefined) ??
			plain ??
			(named !== undefined ? byFamily.get(named) : undefined) ??
			licenses[0]

		if (file !== undefined) {
			chosen.push(file)
		}
	}

	// Apache-2.0 §4(d) requires a NOTICE file to travel with the distribution, so it ships alongside
	// the terms rather than instead of them.
	if (chosen.some(name => licenseFamily(name) === "APACHE") || licenseFamily(declared) === "APACHE") {
		chosen.push(...names.filter(name => NOTICE_FILE.test(baseName(name))))
	}

	chosen.push(...names.filter(name => COPYRIGHT_FILE.test(baseName(name))))

	return [...new Set(chosen)].map(name => readIfPresent(dir, name)).filter((text): text is string => text !== null)
}

/**
 * A short heading rather than license prose — "MIT License", "(The MIT License)", "The MIT License
 * (MIT)". These sit ABOVE the copyright in the majority of real files, so the header region cannot end
 * at the first non-blank line without the copyright below them becoming unliftable.
 */
function isHeadingLine(line: string): boolean {
	const trimmed = line.trim()

	return trimmed.length > 0 && trimmed.length <= 60 && !/[.;:]$/.test(trimmed)
}

/**
 * Splits a license file into its copyright lines and the terms that follow.
 *
 * The header region runs until the first line of actual prose. Ending it at the first non-blank line
 * instead — which is what this did originally — meant any file opening with a title kept its copyright
 * buried in the shared terms: 411 of 453 texts, and 1456 entries rendering an empty copyright block.
 *
 * Only lines matching COPYRIGHT_LINE are ever lifted. Headings are held back and restored, so widening
 * the region changes where we stop looking, never what counts as a copyright.
 */
function splitCopyright(text: string): { copyright: string[]; terms: string } {
	const lines = text.split("\n")
	const copyright: string[] = []
	const kept: string[] = []
	const heldBack: string[] = []
	let inHeader = true

	for (const line of lines) {
		if (inHeader) {
			// A "Copyright" inside the terms (Apache-2.0 §4 names one) belongs to the license and must
			// stay put — which is exactly what ending the header region protects.
			if (COPYRIGHT_LINE.test(line)) {
				copyright.push(line.trim())

				continue
			}

			if (line.trim().length === 0) {
				if (heldBack.length > 0) {
					heldBack.push(line)
				}

				continue
			}

			if (isHeadingLine(line)) {
				heldBack.push(line)

				continue
			}

			inHeader = false

			kept.push(...heldBack, line)

			continue
		}

		kept.push(line)
	}

	return {
		copyright,
		// A file that was ALL header (a bare copyright notice with no terms) still yields its held-back
		// lines rather than an empty body.
		terms: (inHeader ? heldBack : kept).join("\n").trim()
	}
}

/**
 * A package's licensing as it will be rendered: every holder lifted out of every text that ships, and
 * the terms those texts leave behind.
 */
function describeLicensing(dir: string | null, declared: string): { copyright: string[]; terms: string[] } {
	const copyright: string[] = []
	const terms: string[] = []

	// A COPYRIGHT file goes through the same header region as any other. Lifting every copyright line in
	// it instead — tried, reverted — reads wrapped clause text ("...retain the above copyright / notice,
	// this list of conditions...") as a holder, and cesu8 has no other file to fall back on.
	for (const text of dir === null ? [] : collectLicenseTexts(dir, declared)) {
		const split = splitCopyright(text)

		copyright.push(...split.copyright)

		if (split.terms.length > 0) {
			terms.push(split.terms)
		}
	}

	// A holder repeated across a package's own files (LICENSE-MIT and LICENSE-APACHE usually agree) is
	// one holder, not two.
	return {
		copyright: [...new Set(copyright)],
		terms
	}
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	} catch {
		return null
	}
}

function spdxOf(value: unknown): string {
	if (typeof value === "string") {
		return value
	}

	if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
		return (value as { type: string }).type
	}

	if (Array.isArray(value) && value[0] && typeof value[0] === "object") {
		const first = value[0] as { type?: unknown }

		return typeof first.type === "string" ? first.type : "UNKNOWN"
	}

	return "UNKNOWN"
}

function repositoryOf(value: unknown): string | null {
	if (typeof value === "string") {
		return value
	}

	if (value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string") {
		return (value as { url: string }).url.replace(/^git\+/, "").replace(/\.git$/, "")
	}

	return null
}

function collectNpm(): Collected[] {
	const lock = readJson(join(packageRoot, "package-lock.json"))
	const packages = (lock?.["packages"] ?? {}) as Record<string, { dev?: boolean; devOptional?: boolean }>
	const seen = new Set<string>()
	const entries: Collected[] = []

	for (const [key, meta] of Object.entries(packages)) {
		if (!key.startsWith("node_modules/") || meta.dev === true || meta.devOptional === true) {
			continue
		}

		// The lockfile key IS the install path, and a nested entry (a/node_modules/b) lives at that path
		// rather than at the top level. Reading from the key rather than the bare name is what lets a
		// deduplicated transitive dependency be described at all.
		const name = key.replace(/.*node_modules\//, "")

		if (seen.has(name)) {
			continue
		}

		const dir = join(packageRoot, key)
		const manifest = readJson(join(dir, "package.json"))

		// Marked seen only once actually described. A name can appear at several paths, and claiming it
		// on the first — which may be an uninstalled optional dependency for another platform — dropped
		// the copy that IS installed.
		if (!manifest) {
			continue
		}

		seen.add(name)

		const license = spdxOf(manifest["license"] ?? manifest["licenses"])
		const licensing = describeLicensing(dir, license)

		entries.push({
			name,
			version: typeof manifest["version"] === "string" ? manifest["version"] : "",
			license,
			ecosystem: "npm",
			copyright: licensing.copyright,
			repository: repositoryOf(manifest["repository"]),
			texts: [],
			terms: licensing.terms
		})
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
		const license = /^\s*license\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? "UNKNOWN"
		const licensing = describeLicensing(dir, license)

		entries.push({
			name,
			version,
			license,
			ecosystem: "rust",
			copyright: licensing.copyright,
			repository: /^\s*repository\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null,
			texts: [],
			terms: licensing.terms
		})
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
		const licensing = describeLicensing(join(podsRoot, name), license)

		entries.push({
			name,
			version,
			license,
			ecosystem: "pod",
			copyright: licensing.copyright,
			repository: repositoryOf(spec?.homepage) ?? repositoryOf(spec?.source?.git),
			texts: [],
			terms: licensing.terms
		})
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

// Deduplicate the terms. An MIT file is byte-identical everywhere once its copyright line is lifted,
// so this is what turns ~1.8 MB into something reasonable to bundle.
const texts: string[] = []
const textIndex = new Map<string, number>()

for (const entry of collected) {
	for (const terms of entry.terms) {
		// Keyed on whitespace-normalised text, but the FIRST occurrence is stored verbatim. Two packages
		// whose MIT terms differ only in line wrapping share one copy; any real difference in wording still
		// separates them, because only whitespace is collapsed.
		const key = terms.replace(/\s+/g, " ").trim().toLowerCase()
		const existing = textIndex.get(key)

		if (existing !== undefined) {
			entry.texts.push(existing)

			continue
		}

		entry.texts.push(texts.length)
		textIndex.set(key, texts.length)
		texts.push(terms)
	}
}

/**
 * Apache-2.0's license file carries no holder — its appendix is a placeholder, and attribution lives in
 * a NOTICE instead. One canonical copy therefore serves every package that elected it, which is what
 * lets Maven modules meet the obligation from a POM declaration alone: 5 of 248 embed their terms.
 *
 * This does NOT generalise. An MIT or BSD file IS the holder, so lending one to a package that shipped
 * none would attribute the wrong author — those stay honestly text-less.
 */
const canonicalApache =
	texts
		.map((text, index) => ({
			index,
			text
		}))
		// The text must BE the document, not merely contain it. Matching on content alone picked MMKV's
		// LICENSE.TXT — it bundles a full Apache-2.0 copy inside a longer file, so it matched and, being
		// the longest, won: every Apache-declaring Maven module rendered Tencent's terms.
		.filter(
			({ text }) =>
				text.trimStart().startsWith("Apache License") &&
				/Version 2\.0, January 2004/.test(text) &&
				/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/.test(text) &&
				/APPENDIX: How to apply the Apache License to your work/.test(text)
		)
		// Shortest of the complete copies: they differ only in how the original file was indented, and
		// the unindented one reads far better on a phone.
		.sort((a, b) => a.text.length - b.text.length)
		.map(({ index }) => index)[0] ?? -1

if (canonicalApache === -1) {
	throw new Error("no canonical Apache-2.0 text was pooled — every Apache-declaring package would ship without terms")
}

for (const entry of collected) {
	if (entry.texts.length === 0 && electedFamily(entry.license) === "APACHE") {
		entry.texts.push(canonicalApache)
	}
}

const notices: Entry[] = collected
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
	ecosystem: "npm" | "rust" | "pod" | "gradle"
	copyright: string[]
	repository: string | null
	texts: number[]
}

export const LICENSE_TEXTS: readonly string[] = ${JSON.stringify(texts, null, 0)}

export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = ${JSON.stringify(notices, null, 0)}
`

writeFileSync(OUTPUT, output, "utf8")

const perEcosystem = ["npm", "rust", "pod", "gradle"].map(ecosystem => {
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
