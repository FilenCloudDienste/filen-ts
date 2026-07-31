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
 * Covers both ecosystems that end up in the binary: the npm tree (minus devDependencies, which are
 * build tooling and never reach a device) and the Rust crates the SDK is compiled from. Crate sources
 * are read out of the local cargo registry cache, so this must run on a machine that has built
 * filen-rs at least once.
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
	ecosystem: "npm" | "rust"
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

	const names = readdirSync(dir)
	const licenses = names.filter(name => LICENSE_FILE.test(name))
	const groups = conjuncts(declared)
	const chosen: string[] = []

	if (groups.length > 1) {
		chosen.push(...licenses)
	} else {
		const byFamily = new Map<string, string>()

		for (const name of licenses) {
			const family = licenseFamily(name)

			// A bare LICENSE/COPYING carries no family token — it is the fallback below, not a candidate,
			// otherwise it would win the election under its own filename.
			if (family !== licenseFamily("LICENSE") && !byFamily.has(family)) {
				byFamily.set(family, name)
			}
		}

		const ranked = (groups[0] ?? []).map(licenseFamily).sort((a, b) => {
			const rankA = ELECTION_ORDER.indexOf(a)
			const rankB = ELECTION_ORDER.indexOf(b)

			return (rankA === -1 ? ELECTION_ORDER.length : rankA) - (rankB === -1 ? ELECTION_ORDER.length : rankB)
		})

		const named = ranked.find(family => byFamily.has(family))
		const plain = licenses.find(name => /^(LICEN[CS]E|COPYING)$/i.test(name))

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
		chosen.push(...names.filter(name => NOTICE_FILE.test(name)))
	}

	chosen.push(...names.filter(name => COPYRIGHT_FILE.test(name)))

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

const collected = [...collectNpm(), ...collectRust()]

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
	ecosystem: "npm" | "rust"
	copyright: string[]
	repository: string | null
	texts: number[]
}

export const LICENSE_TEXTS: readonly string[] = ${JSON.stringify(texts, null, 0)}

export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = ${JSON.stringify(notices, null, 0)}
`

writeFileSync(OUTPUT, output, "utf8")

const npmCount = notices.filter(entry => entry.ecosystem === "npm").length

console.log(
	[
		`third-party notices -> ${OUTPUT}`,
		`  npm packages:   ${npmCount}`,
		`  rust crates:    ${notices.length - npmCount}`,
		`  total:          ${notices.length}`,
		`  license texts:  ${texts.length} unique (deduplicated)`,
		`  with text:      ${withText}`,
		`  without text:   ${notices.length - withText}`,
		`  payload:        ${(Buffer.byteLength(output, "utf8") / 1024).toFixed(0)} KB`
	].join("\n")
)
