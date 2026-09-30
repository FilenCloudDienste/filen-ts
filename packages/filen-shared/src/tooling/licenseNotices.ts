import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The platform-free core of the apps' third-party notices generators: license-file discovery, SPDX
 * election, copyright lifting and terms pooling. Node-only build tooling, reachable solely through the
 * "@filen/shared/tooling" subpath so it never enters an app bundle.
 *
 * A package whose license file cannot be found keeps its SPDX id and repository URL and points at no
 * text. Substituting another package's text of the same license would attribute the wrong copyright
 * holder, which is worse than an honest gap.
 */

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

/** A conjunct's alternatives as families, best-ranked first. */
function rankAlternatives(alternatives: string[]): string[] {
	return alternatives.map(licenseFamily).sort((a, b) => rankLicense(a) - rankLicense(b))
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

		const ranked = rankAlternatives(groups[0] ?? [])
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
	const copyright: string[] = []
	const kept: string[] = []
	const heldBack: string[] = []
	let inHeader = true

	for (const line of text.split("\n")) {
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
export function describeLicensing(dir: string | null, declared: string): { copyright: string[]; terms: string[] } {
	const copyright: string[] = []
	const terms: string[] = []

	// A COPYRIGHT file goes through the same header region as any other. Lifting every copyright line in
	// it instead reads wrapped clause text ("...retain the above copyright / notice, this list of
	// conditions...") as a holder.
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

/** One package's attribution as the generated payload stores it. */
export type NoticeEntry<E extends string = string> = {
	name: string
	version: string
	license: string
	ecosystem: E
	copyright: string[]
	repository: string | null
	/** Indices into the deduplicated boilerplate table. Empty when no license file was found. */
	texts: number[]
}

/** An entry before its terms are pooled — carries the verbatim texts the dedup pass replaces. */
export type CollectedNotice<E extends string = string> = NoticeEntry<E> & { terms: string[] }

/**
 * A collected entry for the package whose license files live in `dir`. Key order is fixed: it is the
 * payload's field order, and callers compare entries through JSON.stringify.
 */
export function describedNotice<E extends string>(fields: {
	name: string
	version: string
	license: string
	ecosystem: E
	dir: string | null
	repository: string | null
}): CollectedNotice<E> {
	const licensing = describeLicensing(fields.dir, fields.license)

	return {
		name: fields.name,
		version: fields.version,
		license: fields.license,
		ecosystem: fields.ecosystem,
		copyright: licensing.copyright,
		repository: fields.repository,
		texts: [],
		terms: licensing.terms
	}
}

/** A Rust crate unpacked at `dir`, described from its Cargo.toml. A null or manifest-less dir is UNKNOWN. */
export function describeCargoCrate(name: string, version: string, dir: string | null): CollectedNotice<"rust"> {
	const manifestPath = dir === null ? null : join(dir, "Cargo.toml")
	const manifest = manifestPath !== null && existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : ""

	return describedNotice({
		name,
		version,
		license: /^\s*license\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? "UNKNOWN",
		ecosystem: "rust",
		dir,
		repository: /^\s*repository\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null
	})
}

/** Pools every entry's terms, then emits the payload entries without them, ordered by name then version. */
export function finalizeNotices<E extends string>(collected: CollectedNotice<E>[]): { texts: string[]; notices: NoticeEntry<E>[] } {
	const texts = poolLicenseTexts(collected)
	const notices = collected
		.map(({ terms: _terms, ...entry }) => entry)
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

	return { texts, notices }
}

export function readJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	} catch {
		return null
	}
}

export function spdxOf(value: unknown): string {
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

export function repositoryOf(value: unknown): string | null {
	if (typeof value === "string") {
		return value
	}

	if (value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string") {
		return (value as { url: string }).url.replace(/^git\+/, "").replace(/\.git$/, "")
	}

	return null
}

export type InstalledNpmPackage = {
	name: string
	version: string
	/** Null when pnpm reports the version without a path — kept so a drift guard still counts it. */
	dir: string | null
}

/**
 * The installed npm packages that ship with `workspacePackage`, read from pnpm rather than from a
 * lockfile, in pnpm's report order.
 *
 * `--prod` follows only `dependencies` edges: a package reachable ONLY through devDependencies is
 * dropped, one reachable through both is kept — the same thing npm's `dev` flag meant. `--no-optional`
 * drops optionalDependencies, whose install set is decided per machine, so counting them would make the
 * payload depend on where it was generated. The `...` on the filter is load-bearing: without it pnpm
 * reports the package's own tree only, and everything @filen/shared brings in silently vanishes from the
 * attribution. @filen/shared itself is a workspace member, is not reported, and is correctly absent.
 */
export function listInstalledNpm(workspacePackage: string, cwd?: string): InstalledNpmPackage[] {
	let raw: string

	try {
		raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod", "--no-optional", "--filter", `${workspacePackage}...`], {
			...(cwd === undefined ? {} : { cwd }),
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024
		})
	} catch (error) {
		throw new Error(
			`\`pnpm licenses list\` failed — pnpm 12 must be on PATH and \`pnpm install\` must have run at the repo root: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error }
		)
	}

	const grouped = JSON.parse(raw) as Record<string, { name?: unknown; versions?: unknown; paths?: unknown }[]>
	const installed: InstalledNpmPackage[] = []

	for (const entries of Object.values(grouped)) {
		for (const { name, versions, paths } of entries) {
			if (typeof name !== "string" || !Array.isArray(versions)) {
				continue
			}

			// versions[i] pairs with paths[i]: one name can be installed at several versions.
			for (let index = 0; index < versions.length; index++) {
				const version: unknown = versions[index]
				const dir: unknown = Array.isArray(paths) ? paths[index] : undefined

				if (typeof version !== "string" || version.length === 0) {
					throw new Error(`pnpm licenses entry for ${name} has no version`)
				}

				installed.push({ name, version, dir: typeof dir === "string" && dir.length > 0 ? dir : null })
			}
		}
	}

	if (installed.length === 0) {
		throw new Error("`pnpm licenses list` reported no packages — run `pnpm install` at the repo root")
	}

	return installed
}

/** A collected notice: `terms` are its verbatim texts, `texts` receives their pooled indices. */
export type PoolableNotice = {
	license: string
	terms: string[]
	texts: number[]
}

/**
 * Deduplicates every entry's terms into one table, appending each entry's indices to its `texts`, and
 * backfills the canonical Apache-2.0 text. An MIT file is byte-identical everywhere once its copyright
 * line is lifted, so this is what makes the payload a reasonable size at all.
 */
export function poolLicenseTexts(collected: PoolableNotice[]): string[] {
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

	// Apache-2.0's license file carries no holder — its appendix is a placeholder, and attribution lives in
	// a NOTICE instead. One canonical copy therefore serves every package that elected it but shipped no
	// file, which is also what lets a Maven module meet the obligation from its POM declaration alone.
	// This does NOT generalise: an MIT or BSD file IS the holder, so lending one would attribute the wrong
	// author — those stay honestly text-less.
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
		if (entry.texts.length === 0 && rankAlternatives(conjuncts(entry.license)[0] ?? [])[0] === "APACHE") {
			entry.texts.push(canonicalApache)
		}
	}

	return texts
}
