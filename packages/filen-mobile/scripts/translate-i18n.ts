// i18n translation pipeline — fills the target-language catalogs (src/locales/<lang>.json)
// from the English source catalog (src/locales/en/*.ts) via the Anthropic Messages API.
//
// Run with: pnpm run translate-i18n          (DELTA mode — only changed English keys)
//           pnpm run translate-i18n --full   (FULL mode — every key for every language)
//           pnpm run translate-i18n de,fr    (restrict to specific languages)
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

import { en } from "@/locales/en"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"

// NOTE: do NOT import from `@/lib/language` here — it transitively pulls in React Native
// (via secureStore), which a Node/tsx run cannot evaluate. `@/locales/languages` is import-free
// by contract (its own comment), so it's the only locale module safe to import in this script.
// The target-language display names below are local to the script for the same reason; the
// single source of truth for WHICH languages exist is still SUPPORTED_LANGUAGES.

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const MODEL = "claude-opus-5"
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(SCRIPT_DIR, "..")
const EN_SOURCE_DIR = join(PACKAGE_DIR, "src", "locales", "en")
const LOCALES_DIR = join(PACKAGE_DIR, "src", "locales")
// Baseline for the DELTA diff: the English catalog as of the last translation (key -> value). Lives
// alongside the language catalogs but is never loaded as one (not a TARGET_LANGUAGE; a dotfile).
const EN_SNAPSHOT_PATH = join(LOCALES_DIR, ".en-snapshot.json")

// "en" is the source language; never a translation target.
type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]
type TargetLanguage = Exclude<SupportedLanguage, "en">

const TARGET_LANGUAGES: readonly TargetLanguage[] = SUPPORTED_LANGUAGES.filter(
	(lang): lang is TargetLanguage => lang !== "en"
)

// English names of the target languages, used only to tell the model what to translate into.
// Typed Record<TargetLanguage, string> so adding a SUPPORTED_LANGUAGES entry forces a name here
// (compile error otherwise). Keep in step with LANGUAGE_LABELS in src/lib/language.ts.
const LANGUAGE_NAMES: Record<TargetLanguage, string> = {
	de: "German",
	es: "Spanish",
	fr: "French",
	it: "Italian",
	"pt-BR": "Brazilian Portuguese (Português do Brasil)",
	"pt-PT": "European Portuguese (Português de Portugal)",
	ru: "Russian",
	ja: "Japanese",
	zh: "Chinese (Simplified)",
	"zh-TW": "Traditional Chinese (Taiwan)",
	bn: "Bengali",
	cs: "Czech",
	da: "Danish",
	fi: "Finnish",
	hi: "Hindi",
	hu: "Hungarian",
	id: "Indonesian",
	ko: "Korean",
	nl: "Dutch",
	no: "Norwegian",
	pl: "Polish",
	ro: "Romanian",
	sv: "Swedish",
	th: "Thai",
	tr: "Turkish",
	uk: "Ukrainian",
	vi: "Vietnamese"
}

// English catalog as a flat key→value map. The barrel merges the area files into one `as const`
// object; every value is a string (plural keys are separate `_one`/`_other` entries).
const EN_CATALOG: Record<string, string> = en

const DRY_RUN = process.env["DRY_RUN"] === "1"

// ---------------------------------------------------------------------------
// English source files as translator context (JSDoc-rich)
// ---------------------------------------------------------------------------

// Concatenate the raw `src/locales/en/*.ts` files as text. Their JSDoc comments describe what
// each key means and where it's used — invaluable context for the translator, and a stable
// prefix that prompt caching reuses across all eight languages.
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
// Delta computation (English catalog vs. committed snapshot)
// ---------------------------------------------------------------------------

type Delta = {
	// Keys whose English value was added or changed → (re)translate for every target.
	upsert: Record<string, string>
	// Keys removed from English → delete from every target catalog.
	removed: readonly string[]
}

// Read a flat string-record JSON file (the English snapshot or a target catalog). Returns null when
// absent or empty; throws on a non-object so a corrupt file fails loudly rather than silently
// re-translating the whole catalog.
function readStringRecord(path: string, label: string): Record<string, string> | null {
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

	return parsed as Record<string, string>
}

// DELTA = the current English catalog diffed against the snapshot baseline. A key whose value changed
// (or a brand-new key absent from the snapshot) is an upsert; a key in the snapshot but no longer in
// English is a removal. Purely content-based — a modified value is caught no matter which commit it
// landed in. With no snapshot yet, assume the catalogs are in sync (empty delta); the per-language
// missing-key fallback in keysToTranslate still fills any genuinely-absent key.
function computeDelta(): Delta {
	const snapshot = readStringRecord(EN_SNAPSHOT_PATH, ".en-snapshot.json")
	const upsert: Record<string, string> = {}
	const removed: string[] = []

	if (snapshot === null) {
		return {
			upsert,
			removed
		}
	}

	for (const [key, value] of Object.entries(EN_CATALOG)) {
		if (snapshot[key] !== value) {
			upsert[key] = value
		}
	}

	for (const key of Object.keys(snapshot)) {
		if (!(key in EN_CATALOG)) {
			removed.push(key)
		}
	}

	return {
		upsert,
		removed
	}
}

// ---------------------------------------------------------------------------
// Per-language merge planning
// ---------------------------------------------------------------------------

// Plural expansion: English defines only `_one` / `_other`; each target gets the CLDR categories an
// integer count can select in that language (see cldrCategories).
const ENGLISH_PLURAL_BASES = computePluralBases(EN_CATALOG)

function pluralBaseOf(key: string): string | null {
	const split = splitPluralKey(key)

	if (split === null) {
		return null
	}

	return ENGLISH_PLURAL_BASES.has(split.base) ? split.base : null
}

// Every (key -> English source text) entry a target language needs for one plural base: the union of
// the categories English defines and the categories the language requires. Categories English lacks
// (`_few` / `_many`) use the English `_other` text as the translation template.
function pluralGroupSources(base: string, lang: TargetLanguage): Record<string, string> {
	const englishCategories = ENGLISH_PLURAL_BASES.get(base) ?? new Set<string>()
	const categories = new Set<string>([...englishCategories, ...cldrCategories(lang)])
	const template = EN_CATALOG[`${base}_other`] ?? EN_CATALOG[`${base}_one`]
	const out: Record<string, string> = {}

	for (const category of categories) {
		const source = EN_CATALOG[`${base}_${category}`] ?? template

		if (source !== undefined) {
			out[`${base}_${category}`] = source
		}
	}

	return out
}

// The subset of English keys (key -> source text) this language needs translated, given the mode and
// its existing catalog. FULL = the whole catalog with plural groups expanded to the language's full
// CLDR set. DELTA = changed English keys + non-plural keys missing from the target + the CLDR plural
// categories missing from the target. A *changed* English plural retranslates its whole group (the
// wording shifted); a merely *incomplete* group only fills the missing categories, so human-reviewed
// `_one` / `_other` forms are never clobbered.
function keysToTranslate(
	args: CliArgs<TargetLanguage>,
	delta: Delta,
	existing: Record<string, string>,
	lang: TargetLanguage
): Record<string, string> {
	const result: Record<string, string> = {}

	if (args.full) {
		const fullGroups = new Set<string>()

		for (const [key, value] of Object.entries(EN_CATALOG)) {
			const base = pluralBaseOf(key)

			if (base === null) {
				result[key] = value
			} else {
				fullGroups.add(base)
			}
		}

		for (const base of fullGroups) {
			Object.assign(result, pluralGroupSources(base, lang))
		}

		return result
	}

	// English-source changes: a changed plural variant flags its whole group for retranslation.
	const changedGroups = new Set<string>()

	for (const [key, value] of Object.entries(delta.upsert)) {
		const base = pluralBaseOf(key)

		if (base === null) {
			result[key] = value
		} else {
			changedGroups.add(base)
		}
	}

	// Non-plural English keys missing from the target (new stub / failed prior run).
	for (const [key, value] of Object.entries(EN_CATALOG)) {
		if (pluralBaseOf(key) !== null) {
			continue
		}

		if (!(key in existing)) {
			result[key] = value
		}
	}

	// Plural groups: retranslate the whole group if its English wording changed, otherwise fill only
	// the CLDR categories the target is missing (this is what supplies `_few` / `_many`).
	for (const base of ENGLISH_PLURAL_BASES.keys()) {
		const sources = pluralGroupSources(base, lang)

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
	// and all eight languages — the first call writes the cache, the rest read it. The varying part
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

	if (block === undefined || block.type !== "text") {
		throw new Error(`No text content returned for ${lang}`)
	}

	const parsed: unknown = JSON.parse(block.text)
	const validated = z.record(z.string(), z.string()).parse(parsed)

	return validated
}

// ---------------------------------------------------------------------------
// Catalog write (sorted keys + trailing newline for stable diffs)
// ---------------------------------------------------------------------------

function writeSortedJson(path: string, record: Record<string, string>): void {
	writeFileSync(path, `${JSON.stringify(sortRecord(record), null, "\t")}\n`, "utf8")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2), TARGET_LANGUAGES)
	const delta = args.full ? { upsert: {}, removed: [] } : computeDelta()
	const englishSource = readEnglishSourceFiles()
	const systemPrompt = buildSystemPrompt(englishSource, "mobile")

	console.log(`[translate-i18n] mode=${args.full ? "FULL" : "DELTA"} dryRun=${DRY_RUN}`)
	console.log(`[translate-i18n] english catalog: ${Object.keys(EN_CATALOG).length} keys`)
	console.log(`[translate-i18n] target languages: ${args.languages.join(", ")}`)

	if (!args.full) {
		console.log(
			`[translate-i18n] delta: ${Object.keys(delta.upsert).length} added/changed, ${delta.removed.length} removed`
		)
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
		const catalogPath = join(LOCALES_DIR, `${lang}.json`)
		const existing = readStringRecord(catalogPath, `Catalog ${lang}.json`) ?? {}
		const subset = keysToTranslate(args, delta, existing, lang)
		const merged: Record<string, string> = {
			...existing
		}

		// Apply removals first so a key removed AND re-added in the same delta nets to the new value.
		// A removed plural variant drops every CLDR-category sibling — including target-only `_few` /
		// `_many` that never appear in the English diff.
		for (const key of delta.removed) {
			delete merged[key]

			const split = splitPluralKey(key)

			if (split !== null) {
				for (const suffix of PLURAL_SUFFIXES) {
					delete merged[`${split.base}_${suffix}`]
				}
			}
		}

		const subsetKeyCount = Object.keys(subset).length

		if (subsetKeyCount > 0) {
			console.log(`[translate-i18n] ${lang}: translating ${subsetKeyCount} keys`)

			const translated = DRY_RUN
				? translateDryRun(lang, subset)
				: await translateSubset({
						label: lang,
						subset,
						translateBatch: batch =>
							translateBatch({
								client: client as Anthropic,
								lang,
								batch,
								systemPrompt
							})
					})

			Object.assign(merged, translated)
		} else {
			console.log(`[translate-i18n] ${lang}: nothing to translate`)
		}

		writeSortedJson(catalogPath, merged)

		console.log(`[translate-i18n] ${lang}: wrote ${Object.keys(merged).length} keys`)
	}

	// Advance the baseline only after every language succeeded — a mid-run throw leaves the old
	// snapshot in place, so a re-run re-detects the same delta and retries. Written into the same PR
	// as the translations, so the baseline only advances once that PR is merged.
	writeSortedJson(EN_SNAPSHOT_PATH, EN_CATALOG)

	console.log("[translate-i18n] done")
}

main().catch(error => {
	// Surface a clean message; never echo the API key.
	console.error("[translate-i18n] failed:", error instanceof Error ? error.message : String(error))
	process.exit(1)
})
