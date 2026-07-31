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
	/** Index into the deduplicated boilerplate table, or -1 when no license file was found. */
	text: number
}

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)([-._].*)?$/i

/** Lines that carry the holder rather than the terms. Lifted out so the terms can be deduplicated. */
const COPYRIGHT_LINE = /^\s*(copyright|\(c\)|©)\b/i

function findLicenseFile(dir: string): string | null {
	if (!existsSync(dir)) {
		return null
	}

	const names = readdirSync(dir).filter(name => LICENSE_FILE.test(name))

	// Prefer a plain LICENSE over LICENSE-APACHE/LICENSE-MIT so dual-licensed packages get the file
	// the project itself considers primary; fall back to whichever exists.
	const preferred = names.find(name => /^(LICEN[CS]E|COPYING)$/i.test(name)) ?? names.find(name => /^LICEN[CS]E/i.test(name)) ?? names[0]

	if (!preferred) {
		return null
	}

	try {
		const text = readFileSync(join(dir, preferred), "utf8")

		return text.trim().length > 0 ? text : null
	} catch {
		return null
	}
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

function collectNpm(): Entry[] {
	const lock = readJson(join(packageRoot, "package-lock.json"))
	const packages = (lock?.["packages"] ?? {}) as Record<string, { dev?: boolean; devOptional?: boolean }>
	const seen = new Set<string>()
	const entries: Entry[] = []

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

		const file = findLicenseFile(dir)
		const split = file ? splitCopyright(file) : null

		entries.push({
			name,
			version: typeof manifest["version"] === "string" ? manifest["version"] : "",
			license: spdxOf(manifest["license"] ?? manifest["licenses"]),
			ecosystem: "npm",
			copyright: split?.copyright ?? [],
			repository: repositoryOf(manifest["repository"]),
			text: -1,
			...(split ? { terms: split.terms } : {})
		} as Entry & { terms?: string })
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

function collectRust(): Entry[] {
	const lockPath = join(packageRoot, "filen-rs", "Cargo.lock")

	if (!existsSync(lockPath)) {
		throw new Error("filen-rs/Cargo.lock is missing — initialise the submodule before generating notices")
	}

	const lock = readFileSync(lockPath, "utf8")
	const roots = crateSourceRoots()
	const entries: Entry[] = []

	const matches = lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g)

	for (const match of matches) {
		const [, name, version, source] = match

		// No `source` means a workspace member — Filen's own code, not a third party.
		if (!source || !name || !version) {
			continue
		}

		const dir = roots.map(root => join(root, `${name}-${version}`)).find(existsSync) ?? null
		const file = dir ? findLicenseFile(dir) : null
		const split = file ? splitCopyright(file) : null
		const manifest = dir && existsSync(join(dir, "Cargo.toml")) ? readFileSync(join(dir, "Cargo.toml"), "utf8") : ""

		entries.push({
			name,
			version,
			license: /^\s*license\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? "UNKNOWN",
			ecosystem: "rust",
			copyright: split?.copyright ?? [],
			repository: /^\s*repository\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null,
			text: -1,
			...(split ? { terms: split.terms } : {})
		} as Entry & { terms?: string })
	}

	return entries
}

const collected = [...collectNpm(), ...collectRust()] as (Entry & { terms?: string })[]

// Deduplicate the terms. An MIT file is byte-identical everywhere once its copyright line is lifted,
// so this is what turns ~1.8 MB into something reasonable to bundle.
const texts: string[] = []
const textIndex = new Map<string, number>()

for (const entry of collected) {
	if (typeof entry.terms !== "string" || entry.terms.length === 0) {
		continue
	}

	// Keyed on whitespace-normalised text, but the FIRST occurrence is stored verbatim. Two packages
	// whose MIT terms differ only in line wrapping share one copy; any real difference in wording still
	// separates them, because only whitespace is collapsed.
	const key = entry.terms.replace(/\s+/g, " ").trim().toLowerCase()
	const existing = textIndex.get(key)

	if (existing !== undefined) {
		entry.text = existing

		continue
	}

	entry.text = texts.length

	textIndex.set(key, texts.length)
	texts.push(entry.terms)
}

const notices: Entry[] = collected
	.map(({ terms: _terms, ...entry }) => entry)
	.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const withText = notices.filter(entry => entry.text !== -1).length

const output = `// GENERATED by scripts/generateThirdPartyNotices.ts — do not edit.
//
// Attribution for everything compiled or bundled into the app: the npm tree minus devDependencies,
// plus the Rust crates the SDK is built from. License terms are deduplicated across packages and the
// copyright lines kept per package, so a rendered notice is that package's copyright followed by the
// verbatim terms. \`text: -1\` means no license file shipped with the package; its SPDX id and
// repository are given instead rather than borrowing another package's copyright.

export type ThirdPartyNotice = {
	name: string
	version: string
	license: string
	ecosystem: "npm" | "rust"
	copyright: string[]
	repository: string | null
	text: number
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
