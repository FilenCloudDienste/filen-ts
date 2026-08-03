import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Emits the third-party attribution payload the Open source licenses dialog renders.
 *
 * MIT, BSD and Apache-2.0 all require the license text AND the copyright notice to accompany the
 * distribution, so listing package names and SPDX ids would not discharge the obligation — the text has
 * to ship inside the app.
 *
 * Shipping it verbatim per package would be megabytes, because an MIT file is identical everywhere
 * except its copyright line. So the copyright lines are lifted out and stored per package, and what
 * remains — the boilerplate — is deduplicated across every package that shares it. Nothing is
 * summarised or paraphrased; a rendered notice is copyright line plus verbatim boilerplate.
 *
 * A package whose license file cannot be found keeps its SPDX id and repository URL and points at no
 * text. Substituting another package's text of the same license would attribute the wrong copyright
 * holder, which is worse than an honest gap.
 *
 * Two ecosystems reach the browser: the npm tree (minus dev/optional entries, which are build tooling)
 * and the Rust crates the SDK wasm is compiled from. The app's own published npm packages (@filen/*)
 * are non-dev lockfile entries and are therefore described here too — that is correct, not a bug.
 *
 * Algorithm adapted from filen-mobile's generator of the same name. There is no shared package and the
 * monorepo has no workspaces, so an adapted copy is the honest call; the pod/gradle collectors are
 * dropped and the npm dedup key is `name@version` rather than the bare name (this tree ships 30
 * packages at two versions, and a bare-name key would silently describe only one of each pair).
 *
 * CANNOT RUN IN CI: it needs a filen-rs checkout and the local cargo caches. Re-run after any
 * @filen/sdk-rs bump; the payload's exported SDK version is checked against package-lock.json by
 * src/tests/thirdPartyNotices.test.ts, so a stale payload fails there rather than shipping quietly.
 *
 * Run from the package root: node --experimental-strip-types scripts/generateThirdPartyNotices.ts
 *   --filen-rs=<path>   filen-rs checkout to read the crate lockfile from
 *   --allow-untagged    read the checkout's working tree instead of the release tag (local experiment
 *                       only — the payload is then stamped worktree@<sha> and fails the payload test)
 */

const OUTPUT = "src/features/settings/thirdPartyNotices.gen.ts"

type Ecosystem = "npm" | "rust"

interface Entry {
	name: string
	version: string
	license: string
	ecosystem: Ecosystem
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
 * "MIT OR Apache-2.0" is a choice offered to us. Electing MIT keeps the obligation to reproducing a
 * short notice; Apache-2.0 additionally requires propagating any NOTICE file and stating changes.
 * Copyleft alternatives sort last so a permissive option always wins when one is offered.
 */
const ELECTION_ORDER = ["MIT", "ISC", "BSD", "0BSD", "ZLIB", "UNLICENSE", "CC0", "APACHE", "UNICODE", "MPL"]

/**
 * Collapses an SPDX id or a license file name onto a family token, so "LICENSE-MIT", "MIT-0" and "MIT"
 * all meet. Order matters: Apache and MPL are tested before MIT because an SPDX id like
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
 * "MIT OR Apache-2.0" is one conjunct with two alternatives, so one text discharges it. "MIT AND Zlib"
 * is two conjuncts, so both texts must ship. Conflating them would under-attribute.
 */
function conjuncts(expression: string): string[][] {
	return splitTopLevel(stripOuterParens(expression), " AND ").map(conjunct =>
		splitTopLevel(stripOuterParens(conjunct), " OR ")
			// The legacy npm shorthand for OR.
			.flatMap(alternative => alternative.split("/"))
			.map(alternative => alternative.trim())
			.filter(alternative => alternative.length > 0)
	)
}

/** A nested name resolves against the same root, so every filename test reads the last segment. */
function baseName(name: string): string {
	return name.slice(name.lastIndexOf("/") + 1)
}

/** The names in `dir` to consider, reaching one level down when the top level holds nothing. */
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
 * over-shipping a text is safe where guessing which ones combine is not.
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
		// likelier to hold that alternative than a named file for a worse-ranked one.
		const file =
			(named !== undefined && named === ranked[0] ? byFamily.get(named) : undefined) ??
			plain ??
			(named !== undefined ? byFamily.get(named) : undefined) ??
			licenses[0]

		if (file !== undefined) {
			chosen.push(file)
		}
	}

	// Apache-2.0 §4(d) requires a NOTICE file to travel with the distribution, so it ships alongside the
	// terms rather than instead of them.
	if (chosen.some(name => licenseFamily(name) === "APACHE") || licenseFamily(declared) === "APACHE") {
		chosen.push(...names.filter(name => NOTICE_FILE.test(baseName(name))))
	}

	chosen.push(...names.filter(name => COPYRIGHT_FILE.test(baseName(name))))

	return [...new Set(chosen)].map(name => readIfPresent(dir, name)).filter((text): text is string => text !== null)
}

/**
 * A short heading rather than license prose — "MIT License", "(The MIT License)". These sit ABOVE the
 * copyright in most real files, so the header region cannot end at the first non-blank line without the
 * copyright below them becoming unliftable.
 */
function isHeadingLine(line: string): boolean {
	const trimmed = line.trim()

	return trimmed.length > 0 && trimmed.length <= 60 && !/[.;:]$/.test(trimmed)
}

/**
 * Splits a license file into its copyright lines and the terms that follow.
 *
 * The header region runs until the first line of actual prose. Only lines matching COPYRIGHT_LINE are
 * ever lifted; headings are held back and restored, so widening the region changes where we stop
 * looking, never what counts as a copyright.
 */
function splitCopyright(text: string): { copyright: string[]; terms: string } {
	const lines = text.split("\n")
	const copyright: string[] = []
	const kept: string[] = []
	const heldBack: string[] = []
	let inHeader = true

	for (const line of lines) {
		if (inHeader) {
			// A "Copyright" inside the terms (Apache-2.0 §4 names one) belongs to the license and must stay
			// put — which is exactly what ending the header region protects.
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

	for (const text of dir === null ? [] : collectLicenseTexts(dir, declared)) {
		const split = splitCopyright(text)

		copyright.push(...split.copyright)

		if (split.terms.length > 0) {
			terms.push(split.terms)
		}
	}

	// A holder repeated across a package's own files (LICENSE-MIT and LICENSE-APACHE usually agree) is
	// one holder, not two.
	return { copyright: [...new Set(copyright)], terms }
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	} catch {
		return null
	}
}

function requireJson(path: string): Record<string, unknown> {
	const json = readJson(path)

	if (json === null) {
		throw new Error(`could not read ${path}`)
	}

	return json
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

interface LockEntry {
	version?: string
	dev?: boolean
	devOptional?: boolean
	optional?: boolean
}

function lockPackages(): Record<string, LockEntry> {
	return (requireJson("package-lock.json")["packages"] ?? {}) as Record<string, LockEntry>
}

/**
 * The npm packages that reach a browser.
 *
 * Identity is `name@version`, not the bare name: several packages ship at two versions in this tree and
 * both are distributed, so a name-keyed dedup would describe only one of each pair. The emitted version
 * is always the LOCKFILE's — the same field the payload test compares against.
 *
 * `optional` is excluded alongside `dev` because npm decides per machine whether to install one, so
 * including them would make the payload depend on where it was generated.
 */
function collectNpm(): Collected[] {
	const seen = new Set<string>()
	const entries: Collected[] = []

	for (const [key, meta] of Object.entries(lockPackages())) {
		if (!key.startsWith("node_modules/") || meta.dev === true || meta.devOptional === true || meta.optional === true) {
			continue
		}

		// The lockfile key IS the install path, and a nested entry (a/node_modules/b) lives at that path
		// rather than at the top level.
		const name = key.replace(/.*node_modules\//, "")
		const version = meta.version

		if (typeof version !== "string" || version.length === 0) {
			throw new Error(`package-lock.json entry ${key} has no version`)
		}

		const id = `${name}@${version}`

		if (seen.has(id)) {
			continue
		}

		const manifest = readJson(join(key, "package.json"))

		// Marked seen only once actually described: a name@version can be reachable at several keys, and
		// claiming it on the first — which may be an uninstalled entry — would drop the copy that IS
		// installed. An id no key can supply stays undescribed and fails the payload's drift guard loudly.
		if (!manifest) {
			continue
		}

		const manifestVersion = manifest["version"]

		if (typeof manifestVersion === "string" && manifestVersion !== version) {
			throw new Error(`${id}: package-lock.json says ${version}, ${key}/package.json says ${manifestVersion} — run npm ci`)
		}

		seen.add(id)

		const license = spdxOf(manifest["license"] ?? manifest["licenses"])
		const licensing = describeLicensing(key, license)

		entries.push({
			name,
			version,
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

function argValue(flag: string): string | undefined {
	return process.argv
		.slice(2)
		.find(arg => arg.startsWith(`${flag}=`))
		?.slice(flag.length + 1)
}

function git(checkout: string, args: string[]): string {
	return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Which filen-rs checkout the crate list comes from, and which of the three candidates supplied it.
 *
 * The monorepo's `packages/filen-mobile/filen-rs` submodule is deliberately NOT a candidate: it is
 * pinned by mobile's native build on mobile's schedule and routinely sits at a different SDK release,
 * so falling through to it would attribute one release's crates to another's wasm.
 */
function resolveCheckout(): { path: string; source: string } {
	const candidates: { path: string; source: string }[] = [
		{ path: argValue("--filen-rs") ?? "", source: "--filen-rs" },
		{ path: process.env["FILEN_RS_PATH"] ?? "", source: "FILEN_RS_PATH" },
		{ path: "../../../filen-rs", source: "sibling" }
	]

	for (const candidate of candidates) {
		if (candidate.path.length > 0 && existsSync(join(candidate.path, "Cargo.lock"))) {
			return candidate
		}
	}

	throw new Error(
		`no filen-rs checkout with a Cargo.lock — tried ${candidates.map(c => `${c.source}=${c.path.length > 0 ? c.path : "(unset)"}`).join(", ")}`
	)
}

/** The crate sources cargo keeps on this machine: registry crates plus git-dependency checkouts. */
function crateSourceRoots(): string[] {
	const roots: string[] = []

	for (const base of [join(homedir(), ".cargo", "registry", "src"), join(homedir(), ".cargo", "git", "checkouts")]) {
		if (!existsSync(base)) {
			continue
		}

		for (const entry of readdirSync(base)) {
			roots.push(join(base, entry))
		}
	}

	return roots
}

/**
 * The Rust crates the shipped wasm is compiled from, read at the RELEASE TAG matching the installed
 * @filen/sdk-rs version.
 *
 * Reading the checkout's working tree instead would attribute whatever the branch happens to be at —
 * measurably a different crate set — and a version equality check alone cannot catch that, because the
 * working tree still declares the same version.
 */
function collectRust(expected: string): { entries: Collected[]; ref: string; source: string; crates: number } {
	const checkout = resolveCheckout()
	const tag = `filen-js@${expected}`
	const allowUntagged = process.argv.includes("--allow-untagged")
	let ref = tag

	try {
		git(checkout.path, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])
	} catch {
		if (!allowUntagged) {
			throw new Error(`${checkout.path} has no tag ${tag} — fetch it (git -C ${checkout.path} fetch --tags) or pass --allow-untagged`)
		}

		ref = `worktree@${git(checkout.path, ["rev-parse", "--short", "HEAD"]).trim()}`
	}

	const atTag = ref === tag
	const cargoToml = atTag
		? git(checkout.path, ["show", `${tag}:filen-sdk-rs/Cargo.toml`])
		: readFileSync(join(checkout.path, "filen-sdk-rs", "Cargo.toml"), "utf8")
	const cargoLock = atTag ? git(checkout.path, ["show", `${tag}:Cargo.lock`]) : readFileSync(join(checkout.path, "Cargo.lock"), "utf8")
	const declared = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml.split("[dependencies]")[0] ?? cargoToml)?.[1]

	if (declared !== expected) {
		throw new Error(`${checkout.path} at ${ref} declares filen-sdk-rs ${declared ?? "(none)"}, expected ${expected}`)
	}

	const roots = crateSourceRoots()
	const entries: Collected[] = []
	const byId = new Map<string, Collected>()
	let crates = 0

	for (const match of cargoLock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g)) {
		const [, name, version, source] = match

		// No `source` means a workspace member — Filen's own code, not a third party.
		if (!source || !name || !version) {
			continue
		}

		crates++

		// A registry crate unpacks to <root>/<name>-<version>; a git dependency to a checkout directory
		// named after the abbreviated revision from the source URL's fragment.
		const rev = /#([0-9a-f]+)$/.exec(source)?.[1]
		const dir =
			roots.map(root => join(root, `${name}-${version}`)).find(existsSync) ??
			(rev === undefined
				? undefined
				: roots
						.flatMap(root => {
							try {
								return readdirSync(root).map(entry => ({ entry, path: join(root, entry) }))
							} catch {
								return []
							}
						})
						.find(({ entry }) => rev.startsWith(entry))?.path)

		if (dir === undefined) {
			throw new Error(`no local source for crate ${name}-${version} — run cargo fetch in ${checkout.path}`)
		}

		const manifestPath = join(dir, "Cargo.toml")
		const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : ""
		const license = /^\s*license\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? "UNKNOWN"
		const licensing = describeLicensing(dir, license)

		const entry: Collected = {
			name,
			version,
			license,
			ecosystem: "rust",
			copyright: licensing.copyright,
			repository: /^\s*repository\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null,
			texts: [],
			terms: licensing.terms
		}

		// The same crate version can be locked twice — once from crates.io and once from a git fork of it.
		// Identical attribution is one notice, not two (the payload is keyed by name@version). Attribution
		// that actually differs is a real ambiguity and throws rather than silently dropping one holder.
		const previous = byId.get(`${name}@${version}`)

		if (previous !== undefined) {
			if (JSON.stringify({ ...previous, texts: [] }) !== JSON.stringify(entry)) {
				throw new Error(`crate ${name}-${version} is locked twice with differing attribution (${previous.license} vs ${license})`)
			}

			continue
		}

		byId.set(`${name}@${version}`, entry)
		entries.push(entry)
	}

	return { entries, ref, source: checkout.source, crates }
}

// The one definition of "the installed SDK": the committed lockfile, which is also what the payload
// test reads. node_modules is only a cross-check, so an edited package.json with no install cannot
// generate a payload that only fails later.
const expectedSdk = lockPackages()["node_modules/@filen/sdk-rs"]?.version

if (typeof expectedSdk !== "string" || expectedSdk.length === 0) {
	throw new Error("package-lock.json has no @filen/sdk-rs entry")
}

const installedSdk = requireJson("node_modules/@filen/sdk-rs/package.json")["version"]

if (installedSdk !== expectedSdk) {
	throw new Error(`package-lock.json says @filen/sdk-rs ${expectedSdk}, node_modules says ${String(installedSdk)} — run npm install`)
}

const npm = collectNpm()
const rust = collectRust(expectedSdk)
const collected = [...npm, ...rust.entries]

// Deduplicate the terms. An MIT file is byte-identical everywhere once its copyright line is lifted, so
// this is what makes the payload a reasonable size at all.
const texts: string[] = []
const textIndex = new Map<string, number>()

for (const entry of collected) {
	for (const terms of entry.terms) {
		// Keyed on whitespace-normalised text, but the FIRST occurrence is stored verbatim: two packages
		// whose MIT terms differ only in line wrapping share one copy; any real difference in wording still
		// separates them.
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
 * a NOTICE instead. One canonical copy therefore serves every package that elected it but shipped no
 * file.
 *
 * This does NOT generalise. An MIT or BSD file IS the holder, so lending one to a package that shipped
 * none would attribute the wrong author — those stay honestly text-less.
 */
const canonicalApache =
	texts
		.map((text, index) => ({ index, text }))
		// The text must BE the document, not merely contain it: a package that bundles a full Apache copy
		// inside a longer file would otherwise win and lend its own terms to everyone.
		.filter(
			({ text }) =>
				text.trimStart().startsWith("Apache License") &&
				text.includes("Version 2.0, January 2004") &&
				text.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION") &&
				text.includes("APPENDIX: How to apply the Apache License to your work")
		)
		// Shortest of the complete copies: they differ only in how the original was indented.
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

// No absolute path is ever written into the artifact: it is a committed source file, and a machine path
// would make regeneration produce a spurious diff on the next machine. The repository, the ref it was
// read at, and which candidate resolved carry the whole diagnostic value.
const output = `// AUTO-GENERATED by scripts/generateThirdPartyNotices.ts — do not edit.
//
// Attribution for everything bundled into the app: the npm tree minus dev/optional entries, plus the
// Rust crates the SDK wasm is built from. License terms are deduplicated across packages and the
// copyright lines kept per package, so a rendered notice is that package's copyright followed by the
// verbatim terms. An empty \`texts\` means no license file shipped with the package; its SPDX id and
// repository are given instead rather than borrowing another package's copyright. More than one entry
// means the declared license is a conjunction — every text applies.
//
// npm:  package-lock.json (${String(npm.length)} name@version packages)
// rust: filen-rs @ ${rust.ref} (${String(rust.crates)} crates)  [resolved via: ${rust.source}]
//
// Cannot run in CI: needs a filen-rs checkout and the local cargo caches. Re-run after any SDK bump.

export type ThirdPartyNotice = {
	name: string
	version: string
	license: string
	ecosystem: "npm" | "rust"
	copyright: string[]
	repository: string | null
	texts: number[]
}

export const THIRD_PARTY_NOTICES_SDK_VERSION = "${expectedSdk}"

export const THIRD_PARTY_NOTICES_FILEN_RS_REF = "${rust.ref}"

export const LICENSE_TEXTS: readonly string[] = ${JSON.stringify(texts, null, 0)}

export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = ${JSON.stringify(notices, null, 0)}
`

writeFileSync(OUTPUT, output, "utf8")

const withText = notices.filter(entry => entry.texts.length > 0).length

console.log(
	[
		`third-party notices -> ${OUTPUT}`,
		`  npm:            ${String(npm.length).padStart(4)}`,
		`  rust:           ${String(rust.entries.length).padStart(4)}  (${rust.ref}, via ${rust.source})`,
		`  total:          ${String(notices.length)}`,
		`  license texts:  ${String(texts.length)} unique (deduplicated)`,
		`  with text:      ${String(withText)}`,
		`  without text:   ${String(notices.length - withText)}`,
		`  payload:        ${(Buffer.byteLength(output, "utf8") / 1024).toFixed(0)} KB`
	].join("\n")
)
