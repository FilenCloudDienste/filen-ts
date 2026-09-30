// i18n translation pipeline — fills the target-language catalogs (src/locales/<lang>.json)
// from the English source catalogs (src/locales/en/*.ts) via the Anthropic Messages API.
//
// The English source is split across real i18next namespaces — the list lives in
// `@/lib/i18n/catalog` (EN_NAMESPACES), and each namespace file exports its own `as const` object.
// Every target-language catalog nests translations under the same namespace keys, e.g.
// `{ "common": {...}, "errors": {...} }`.
//
// Run with: pnpm run translate-i18n          (DELTA mode — only changed English keys)
//           pnpm run translate-i18n --full   (FULL mode — every key for every language)
//           pnpm run translate-i18n de       (restrict to specific languages)
//           No `--` separator: pnpm forwards it to the script as a literal argument.
//
// Modes:
//   DELTA (default) — compare the English catalog against the committed snapshot
//                     (src/locales/.en-snapshot.json) to find added/modified/removed keys, then
//                     translate only the added/modified ones and delete the removed ones from every
//                     target catalog. Content-based, so a changed value is caught regardless of git
//                     history (no dependence on commit topology, force-pushes, or squash merges).
//                     Plus a safety net: any key present in `en` but missing from a target catalog is
//                     treated as added (covers a brand-new empty stub or a previously-failed run).
//                     After a successful run the snapshot is rewritten to the current English catalog.
//   FULL (--full)   — translate every English key for every target language (ignores the snapshot).
//
// DRY_RUN=1 — skip the Anthropic API entirely; stub each translation as "<lang>:<english>"
//             (e.g. "de:Cancel"). Lets the catalog-read / delta / file-write logic be exercised
//             with zero token spend. The stub is OBVIOUS in code (see translateDryRun below).
//
// Reads ANTHROPIC_API_KEY from the environment — never hardcoded, never logged.

import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
	buildOutputSchema,
	buildSystemPrompt,
	computePluralBases,
	cldrCategories,
	parseCliArgs,
	PLURAL_SUFFIXES,
	sortRecord,
	splitPluralKey,
	translateSubset,
	type CliArgs
} from "@filen/shared/tooling/i18n"

import { EN_NAMESPACES, EN_CATALOGS, type EnNamespace } from "@/lib/i18n/catalog"

// NOTE: do NOT import from `@/lib/i18n` here — its index module runs
// `i18n.use(initReactI18next).init(...)` as an import-time side effect the moment it's loaded,
// which this script has no reason to trigger. `@/lib/i18n/catalog` is the sanctioned import: it is
// side-effect free and owns the namespace list both the app and this pipeline read, so a namespace
// added there is translated without touching this file.
//
// TARGET_LANGUAGES/LANGUAGE_NAMES live in this script rather than a shared module (unlike
// mobile's `@/locales/languages`): nothing else in the app consumes the target-language list yet.
// LANGUAGE_NAMES is typed `Record<TargetLanguage, string>`, so adding a language to
// TARGET_LANGUAGES without a matching name is a compile error.

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const MODEL = "claude-opus-4-8"
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(SCRIPT_DIR, "..")
const EN_SOURCE_DIR = join(PACKAGE_DIR, "src", "locales", "en")
const LOCALES_DIR = join(PACKAGE_DIR, "src", "locales")
// Baseline for the DELTA diff: the English catalog as of the last translation (namespace -> key ->
// value). Lives alongside the language catalogs but is never loaded as one (not a TARGET_LANGUAGE;
// a dotfile).
const EN_SNAPSHOT_PATH = join(LOCALES_DIR, ".en-snapshot.json")

// ---------------------------------------------------------------------------
// Target languages
// ---------------------------------------------------------------------------

// Single source of truth for which languages this pipeline currently translates into. "de" only
// while app copy is still stabilizing; expanding towards mobile's full language set later is a
// one-line addition here — LANGUAGE_NAMES below forces a matching entry for every language added.
export const TARGET_LANGUAGES = ["de"] as const

type TargetLanguage = (typeof TARGET_LANGUAGES)[number]

// English names of the target languages, used only to tell the model what to translate into.
const LANGUAGE_NAMES: Record<TargetLanguage, string> = {
	de: "German"
}

// ---------------------------------------------------------------------------
// English source catalog (real i18next namespaces)
// ---------------------------------------------------------------------------

const NAMESPACES = EN_NAMESPACES

type Namespace = EnNamespace

// One flat key→value map per namespace; every value is a string (plural keys are separate
// `_one`/`_other` entries). Unlike mobile's single merged `en` barrel, keys only need to be unique
// WITHIN a namespace — this mirrors the app's real i18next config (keySeparator/nsSeparator ON,
// real namespaces), so the delta/plural/translation machinery below is scoped per namespace.
const EN_CATALOG: Record<Namespace, Record<string, string>> = EN_CATALOGS

// Every per-namespace record below is built from NAMESPACES, so adding a namespace to the catalog
// module is the only edit a new namespace needs. Object.fromEntries erases the key union, so the
// result is re-typed once, here — NAMESPACES lists every key of the catalog object Namespace is derived
// from, so every key is present by construction.
function perNamespace<T>(make: (ns: Namespace) => T): Record<Namespace, T> {
	return Object.fromEntries(NAMESPACES.map(ns => [ns, make(ns)])) as Record<Namespace, T>
}

const DRY_RUN = process.env["DRY_RUN"] === "1"

// ---------------------------------------------------------------------------
// English source files as translator context (JSDoc-rich)
// ---------------------------------------------------------------------------

// Concatenate the raw `src/locales/en/*.ts` files as text. Their JSDoc comments describe what
// each key means and where it's used — invaluable context for the translator, and a stable
// prefix that prompt caching reuses across every target language.
function readEnglishSourceFiles(): string {
	const files = readdirSync(EN_SOURCE_DIR)
		.filter(name => name.endsWith(".ts"))
		.sort()

	const parts: string[] = []

	for (const name of files) {
		const contents = readFileSync(join(EN_SOURCE_DIR, name), "utf8")

		parts.push(`// ===== src/locales/en/${name} =====\n${contents}`)
	}

	return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Delta computation (English catalog vs. committed snapshot), scoped per namespace
// ---------------------------------------------------------------------------

interface NamespaceDelta {
	// Keys whose English value was added or changed → (re)translate for every target.
	upsert: Record<string, string>
	// Keys removed from English → delete from every target catalog.
	removed: readonly string[]
}

type Delta = Record<Namespace, NamespaceDelta>

function emptyDelta(): Delta {
	return perNamespace(() => ({ upsert: {}, removed: [] }))
}

// Shared shape check for one namespace's slice of a parsed catalog/snapshot JSON file: absent →
// empty catalog (forward-compatible with a namespace added after the file was written), present
// but not a plain object → throw (a corrupt file fails loudly instead of silently losing data).
function readNamespaceRecord(record: Record<string, unknown>, ns: Namespace, fileLabel: string): Record<string, string> {
	const value = record[ns]

	if (value === undefined) {
		return {}
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${fileLabel} namespace "${ns}" is not a JSON object`)
	}

	return value as Record<string, string>
}

// Read a JSON file holding a plain object. Returns null when absent or blank; throws on any other
// shape so a corrupt file fails loudly instead of silently losing data.
function readJsonObject(path: string, label: string): Record<string, unknown> | null {
	if (!existsSync(path)) {
		return null
	}

	const raw = readFileSync(path, "utf8").trim()

	if (raw.length === 0) {
		return null
	}

	const parsed: unknown = JSON.parse(raw)

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${label} is not a JSON object`)
	}

	return parsed as Record<string, unknown>
}

// Read the English snapshot (the DELTA baseline) — the catalog as of the last translation, nested
// by namespace like the target catalogs. Returns null when absent (first run / not yet seeded) so
// the caller re-baselines instead of retranslating everything; throws on a malformed file so a
// corrupt baseline fails loudly rather than silently re-translating the whole catalog.
function readSnapshot(): Record<Namespace, Record<string, string>> | null {
	const record = readJsonObject(EN_SNAPSHOT_PATH, ".en-snapshot.json")

	if (record === null) {
		return null
	}

	return perNamespace(ns => readNamespaceRecord(record, ns, ".en-snapshot.json"))
}

// DELTA = the current English catalog diffed against the snapshot baseline, per namespace. A key
// whose value changed (or a brand-new key absent from the snapshot) is an upsert; a key in the
// snapshot but no longer in English is a removal. Purely content-based — a modified value is
// caught no matter which commit it landed in. With no snapshot yet, assume the catalogs are in
// sync (empty delta); the per-language missing-key fallback in keysToTranslate still fills any
// genuinely-absent key.
function computeDelta(): Delta {
	const snapshot = readSnapshot()

	if (snapshot === null) {
		return emptyDelta()
	}

	return perNamespace(ns => computeNamespaceDelta(snapshot[ns], EN_CATALOG[ns]))
}

function computeNamespaceDelta(baseline: Record<string, string>, catalog: Record<string, string>): NamespaceDelta {
	const upsert: Record<string, string> = {}
	const removed: string[] = []

	for (const [key, value] of Object.entries(catalog)) {
		if (baseline[key] !== value) {
			upsert[key] = value
		}
	}

	for (const key of Object.keys(baseline)) {
		if (!(key in catalog)) {
			removed.push(key)
		}
	}

	return { upsert, removed }
}

// ---------------------------------------------------------------------------
// Per-language merge planning
// ---------------------------------------------------------------------------

function readTargetCatalog(lang: TargetLanguage): Record<Namespace, Record<string, string>> {
	const fileLabel = `Catalog ${lang}.json`
	const record = readJsonObject(join(LOCALES_DIR, `${lang}.json`), fileLabel)

	return perNamespace(ns => (record === null ? {} : readNamespaceRecord(record, ns, fileLabel)))
}

// Plural groups are scoped to their own namespace, never merged across namespaces.
const ENGLISH_PLURAL_BASES: Record<Namespace, ReadonlyMap<string, ReadonlySet<string>>> = perNamespace(ns =>
	computePluralBases(EN_CATALOG[ns])
)

function pluralBaseOf(ns: Namespace, key: string): string | null {
	const split = splitPluralKey(key)

	if (split === null) {
		return null
	}

	return ENGLISH_PLURAL_BASES[ns].has(split.base) ? split.base : null
}

// Every (key -> English source text) entry a target language needs for one plural base, within one
// namespace: the union of the categories English defines and the categories the language requires.
// Categories English lacks (`_few` / `_many`) use the English `_other` text as the translation
// template.
function pluralGroupSources(ns: Namespace, base: string, lang: TargetLanguage): Record<string, string> {
	const catalog = EN_CATALOG[ns]
	const englishCategories = ENGLISH_PLURAL_BASES[ns].get(base) ?? new Set<string>()
	const categories = new Set<string>([...englishCategories, ...cldrCategories(lang)])
	const template = catalog[`${base}_other`] ?? catalog[`${base}_one`]
	const out: Record<string, string> = {}

	for (const category of categories) {
		const source = catalog[`${base}_${category}`] ?? template

		if (source !== undefined) {
			out[`${base}_${category}`] = source
		}
	}

	return out
}

// The subset of English keys (key -> source text) this language needs translated for one namespace,
// given the mode and its existing catalog. FULL = the whole namespace with plural groups expanded to
// the language's full CLDR set. DELTA = changed English keys + non-plural keys missing from the
// target + the CLDR plural categories missing from the target. A *changed* English plural
// retranslates its whole group (the wording shifted); a merely *incomplete* group only fills the
// missing categories, so human-reviewed `_one` / `_other` forms are never clobbered.
function keysToTranslate(
	ns: Namespace,
	args: CliArgs<TargetLanguage>,
	delta: NamespaceDelta,
	existing: Record<string, string>,
	lang: TargetLanguage
): Record<string, string> {
	const catalog = EN_CATALOG[ns]
	const result: Record<string, string> = {}

	if (args.full) {
		const fullGroups = new Set<string>()

		for (const [key, value] of Object.entries(catalog)) {
			const base = pluralBaseOf(ns, key)

			if (base === null) {
				result[key] = value
			} else {
				fullGroups.add(base)
			}
		}

		for (const base of fullGroups) {
			Object.assign(result, pluralGroupSources(ns, base, lang))
		}

		return result
	}

	// English-source changes: a changed plural variant flags its whole group for retranslation.
	const changedGroups = new Set<string>()

	for (const [key, value] of Object.entries(delta.upsert)) {
		const base = pluralBaseOf(ns, key)

		if (base === null) {
			result[key] = value
		} else {
			changedGroups.add(base)
		}
	}

	// Non-plural English keys missing from the target (new stub / failed prior run).
	for (const [key, value] of Object.entries(catalog)) {
		if (pluralBaseOf(ns, key) !== null) {
			continue
		}

		if (!(key in existing)) {
			result[key] = value
		}
	}

	// Plural groups: retranslate the whole group if its English wording changed, otherwise fill only
	// the CLDR categories the target is missing (this is what supplies `_few` / `_many`).
	for (const base of ENGLISH_PLURAL_BASES[ns].keys()) {
		const sources = pluralGroupSources(ns, base, lang)

		if (changedGroups.has(base)) {
			Object.assign(result, sources)

			continue
		}

		for (const [key, value] of Object.entries(sources)) {
			if (!(key in existing)) {
				result[key] = value
			}
		}
	}

	return result
}

// ---------------------------------------------------------------------------
// Translation — Anthropic Messages API (with prompt caching) or DRY_RUN stub
// ---------------------------------------------------------------------------

// DRY_RUN stub: prefix every English value with the lang code. Obvious, deterministic, free.
function translateDryRun(lang: TargetLanguage, subset: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {}

	for (const [key, value] of Object.entries(subset)) {
		result[key] = `${lang}:${value}`
	}

	return result
}

async function translateBatch(args: {
	client: Anthropic
	lang: TargetLanguage
	batch: Record<string, string>
	systemPrompt: string
}): Promise<Record<string, string>> {
	const { client, lang, batch, systemPrompt } = args
	const languageName = LANGUAGE_NAMES[lang]

	// Stable, cached system prefix (instructions + full English source) is reused across every batch
	// and every target language — the first call writes the cache, the rest read it. The varying part
	// (the batch subset + the target language name) lives in the per-language user message.
	const response = await client.messages.create({
		model: MODEL,
		max_tokens: 8192,
		system: [
			{
				type: "text",
				text: systemPrompt,
				cache_control: {
					type: "ephemeral"
				}
			}
		],
		output_config: {
			format: {
				type: "json_schema",
				schema: buildOutputSchema(Object.keys(batch))
			}
		},
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: [
							`Translate these English UI strings to ${languageName}.`,
							"Return ONLY the JSON map of the same keys to their translated values.",
							"",
							JSON.stringify(batch, null, 2)
						].join("\n")
					}
				]
			}
		]
	})

	const block = response.content.find(part => part.type === "text")

	if (block?.type !== "text") {
		throw new Error(`No text content returned for ${lang}`)
	}

	const parsed: unknown = JSON.parse(block.text)
	const validated = z.record(z.string(), z.string()).parse(parsed)

	return validated
}

// ---------------------------------------------------------------------------
// Catalog write (sorted keys + trailing newline for stable diffs)
// ---------------------------------------------------------------------------

function writeSortedJson(path: string, byNamespace: Record<Namespace, Record<string, string>>): void {
	const sorted: Record<Namespace, Record<string, string>> = perNamespace(ns => sortRecord(byNamespace[ns]))

	writeFileSync(path, `${JSON.stringify(sorted, null, "\t")}\n`, "utf8")
}

function writeCatalog(lang: TargetLanguage, catalog: Record<Namespace, Record<string, string>>): void {
	writeSortedJson(join(LOCALES_DIR, `${lang}.json`), catalog)
}

// Rewrite the snapshot to the current English catalog (sorted + trailing newline, like the target
// catalogs, and nested by namespace the same way) so the next DELTA diffs against this state. Written
// into the same PR as the translations, so the baseline only advances once that PR is merged — an
// unmerged run keeps re-detecting the same delta.
function writeSnapshot(): void {
	writeSortedJson(EN_SNAPSHOT_PATH, EN_CATALOG)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2), TARGET_LANGUAGES)
	const delta = args.full ? emptyDelta() : computeDelta()
	const englishSource = readEnglishSourceFiles()
	const systemPrompt = buildSystemPrompt(englishSource, "web")
	const englishKeyCount = NAMESPACES.reduce((sum, ns) => sum + Object.keys(EN_CATALOG[ns]).length, 0)

	console.log(`[translate-i18n] mode=${args.full ? "FULL" : "DELTA"} dryRun=${String(DRY_RUN)}`)
	console.log(`[translate-i18n] english catalog: ${String(englishKeyCount)} keys across ${String(NAMESPACES.length)} namespaces`)
	console.log(`[translate-i18n] target languages: ${args.languages.join(", ")}`)

	if (!args.full) {
		const upsertCount = NAMESPACES.reduce((sum, ns) => sum + Object.keys(delta[ns].upsert).length, 0)
		const removedCount = NAMESPACES.reduce((sum, ns) => sum + delta[ns].removed.length, 0)

		console.log(`[translate-i18n] delta: ${String(upsertCount)} added/changed, ${String(removedCount)} removed`)
	}

	let client: Anthropic | null = null

	if (!DRY_RUN) {
		const apiKey = process.env["ANTHROPIC_API_KEY"]

		if (apiKey === undefined || apiKey.length === 0) {
			throw new Error("ANTHROPIC_API_KEY is not set (and DRY_RUN is not enabled)")
		}

		// The SDK reads ANTHROPIC_API_KEY from the environment itself; constructing without
		// passing the value keeps it out of any logged constructor args.
		client = new Anthropic()
	}

	for (const lang of args.languages) {
		const existing = readTargetCatalog(lang)
		const merged: Record<Namespace, Record<string, string>> = perNamespace(ns => ({ ...existing[ns] }))

		for (const ns of NAMESPACES) {
			// Apply removals first so a key removed AND re-added in the same delta nets to the new value.
			// A removed plural variant drops every CLDR-category sibling — including target-only `_few` /
			// `_many` that never appear in the English diff.
			for (const key of delta[ns].removed) {
				Reflect.deleteProperty(merged[ns], key)

				const split = splitPluralKey(key)

				if (split !== null) {
					for (const suffix of PLURAL_SUFFIXES) {
						Reflect.deleteProperty(merged[ns], `${split.base}_${suffix}`)
					}
				}
			}

			const subset = keysToTranslate(ns, args, delta[ns], existing[ns], lang)
			const subsetKeyCount = Object.keys(subset).length

			if (subsetKeyCount > 0) {
				console.log(`[translate-i18n] ${lang}/${ns}: translating ${String(subsetKeyCount)} keys`)

				// Branch on `client`'s own nullability (never DRY_RUN directly) so TypeScript can prove
				// non-null in the translateSubset branch without a type assertion — client is null if
				// and only if DRY_RUN is true, by construction above.
				const translated =
					client === null
						? translateDryRun(lang, subset)
						: await translateSubset({
								label: `${lang}/${ns}`,
								subset,
								translateBatch: batch =>
									translateBatch({
										client,
										lang,
										batch,
										systemPrompt
									})
							})

				Object.assign(merged[ns], translated)
			} else {
				console.log(`[translate-i18n] ${lang}/${ns}: nothing to translate`)
			}
		}

		writeCatalog(lang, merged)

		const writtenCount = NAMESPACES.reduce((sum, ns) => sum + Object.keys(merged[ns]).length, 0)

		console.log(`[translate-i18n] ${lang}: wrote ${String(writtenCount)} keys`)
	}

	// Advance the baseline only after every language succeeded — a mid-run throw leaves the old
	// snapshot in place, so a re-run re-detects the same delta and retries.
	writeSnapshot()

	console.log("[translate-i18n] done")
}

main().catch((error: unknown) => {
	// Surface a clean message; never echo the API key.
	console.error("[translate-i18n] failed:", error instanceof Error ? error.message : String(error))
	process.exit(1)
})
