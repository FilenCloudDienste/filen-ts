// i18n translation pipeline — fills the target-language catalogs (src/locales/<lang>.json)
// from the English source catalog (src/locales/en/*.ts) via the Anthropic Messages API.
//
// Run with: npm run translate-i18n            (DELTA mode — only changed English keys)
//           npm run translate-i18n -- --full  (FULL mode — every key for every language)
//           npm run translate-i18n -- de,fr   (restrict to specific languages)
//
// Modes:
//   DELTA (default) — diff src/locales/en between HEAD~1 and HEAD to find added/modified/removed
//                     keys, then translate only the added/modified ones and delete the removed
//                     ones from every target catalog. Plus a safety net: any key present in `en`
//                     but missing from a target catalog is treated as added (covers a brand-new
//                     empty stub or a previously-failed run).
//   FULL (--full)   — translate every English key for every target language (ignores git).
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
import { execFileSync } from "node:child_process"

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

const MODEL = "claude-opus-4-8"
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(SCRIPT_DIR, "..")
const EN_SOURCE_DIR = join(PACKAGE_DIR, "src", "locales", "en")
const LOCALES_DIR = join(PACKAGE_DIR, "src", "locales")
// Git pathspecs resolve relative to the process cwd, not the repo root. `gitShow` runs git with
// `cwd: PACKAGE_DIR`, so this pathspec must be relative to the package — NOT prefixed with
// `packages/filen-mobile/` (that would resolve to a non-existent doubled path and silently match
// nothing, so the delta would always be empty).
const EN_SOURCE_GIT_PATHSPEC = "src/locales/en"

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
	pt: "Portuguese",
	ru: "Russian",
	ja: "Japanese",
	zh: "Chinese (Simplified)",
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
// CLI args
// ---------------------------------------------------------------------------

type Args = {
	full: boolean
	languages: readonly TargetLanguage[]
}

function parseArgs(argv: readonly string[]): Args {
	let full = false
	const requested: TargetLanguage[] = []

	for (const arg of argv) {
		if (arg === "--full") {
			full = true

			continue
		}

		// Accept a bare or comma-separated language list, e.g. `de` or `de,fr,ja`.
		for (const candidate of arg.split(",")) {
			const trimmed = candidate.trim()

			if (trimmed.length === 0) {
				continue
			}

			if ((TARGET_LANGUAGES as readonly string[]).includes(trimmed)) {
				requested.push(trimmed as TargetLanguage)
			} else {
				throw new Error(`Unknown target language "${trimmed}". Valid: ${TARGET_LANGUAGES.join(", ")}`)
			}
		}
	}

	return {
		full,
		languages: requested.length > 0 ? requested : TARGET_LANGUAGES
	}
}

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
// Delta computation (git diff of the English source)
// ---------------------------------------------------------------------------

type Delta = {
	// Keys whose English value was added or changed → (re)translate for every target.
	upsert: Record<string, string>
	// Keys removed from English → delete from every target catalog.
	removed: readonly string[]
}

// Extract the flat key set from a committed revision of src/locales/en by importing nothing —
// we can't `import` an arbitrary git blob, so instead we reuse the current barrel for the value
// map and rely on git only to tell us WHICH keys changed. We compute changed keys by diffing the
// raw source text of the previous vs current revision for `key:` definitions.
//
// Simplest correct approach per the design: `git diff HEAD~1 -- <en dir>` to get added/modified/
// removed key lines. We parse `+`/`-` lines for top-level `key: "..."` definitions.
function gitShow(revision: string): string | null {
	try {
		// `git diff` between the two revisions, restricted to the English source dir.
		return execFileSync("git", ["diff", "--unified=0", revision, "--", EN_SOURCE_GIT_PATHSPEC], {
			cwd: PACKAGE_DIR,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"]
		})
	} catch {
		return null
	}
}

// Match a flat catalog key definition line, e.g. `\tappearance: "Appearance",` or
// `\tselected_one: "{{count}} selected"`. Captures the key name only.
const KEY_LINE = /^[+-]\s*([a-zA-Z0-9_]+)\s*:\s*["'`]/

function computeDelta(): Delta {
	const diff = gitShow("HEAD~1")

	const addedOrChanged = new Set<string>()
	const deletedCandidates = new Set<string>()

	if (diff !== null) {
		for (const line of diff.split("\n")) {
			// Ignore diff headers (+++/---).
			if (line.startsWith("+++") || line.startsWith("---")) {
				continue
			}

			const match = KEY_LINE.exec(line)

			if (match === null) {
				continue
			}

			const key = match[1]

			if (key === undefined) {
				continue
			}

			if (line.startsWith("+")) {
				addedOrChanged.add(key)
			} else if (line.startsWith("-")) {
				deletedCandidates.add(key)
			}
		}
	}

	// A key that appears on both a `+` and `-` line is a modification (re-translate); a key only
	// on `-` lines and no longer in the current English catalog is a genuine removal.
	const upsert: Record<string, string> = {}
	const removed: string[] = []

	for (const key of addedOrChanged) {
		const value = EN_CATALOG[key]

		if (value !== undefined) {
			upsert[key] = value
		}
	}

	for (const key of deletedCandidates) {
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

function readTargetCatalog(lang: TargetLanguage): Record<string, string> {
	const path = join(LOCALES_DIR, `${lang}.json`)

	if (!existsSync(path)) {
		return {}
	}

	const raw = readFileSync(path, "utf8").trim()

	if (raw.length === 0) {
		return {}
	}

	const parsed: unknown = JSON.parse(raw)

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Catalog ${lang}.json is not a JSON object`)
	}

	return parsed as Record<string, string>
}

// --- CLDR plural expansion -------------------------------------------------
//
// English defines only `_one` / `_other` for count keys, but several languages need more CLDR
// categories for INTEGER counts: Slavic ru/uk/pl add `_few` and `_many`, while Czech and Romanian add
// `_few`. The app's i18next picks the form via `Intl.PluralRules.select(count)`, so a category an
// integer count can select but the catalog lacks falls back to the ENGLISH string. We emit exactly the
// integer-reachable categories — Intl is the single source of truth, no hand-maintained table — which
// is why categories that only fire for decimals (Czech `many`) or exact millions (Romance `many`) are
// intentionally NOT generated: they would be dead keys the model fills inconsistently and that diverge
// from the hand-reviewed catalogs.

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const

const cldrCategoriesCache = new Map<string, readonly string[]>()

// The plural categories an INTEGER count can actually select for this language. Sampling 0..200 covers
// every modulo-10 / modulo-100 CLDR rule (Slavic few/many cycles, Romanian few = 0 or n%100 in 1..19)
// while excluding decimal-only and millions-only categories. `_one` / `_other` are kept regardless,
// because pluralGroupSources unions this with the categories English itself defines.
function cldrCategories(lang: string): readonly string[] {
	const cached = cldrCategoriesCache.get(lang)

	if (cached !== undefined) {
		return cached
	}

	const rules = new Intl.PluralRules(lang, { type: "cardinal" })
	const reachable = new Set<string>()

	for (let n = 0; n <= 200; n++) {
		reachable.add(rules.select(n))
	}

	const categories = [...reachable]

	cldrCategoriesCache.set(lang, categories)

	return categories
}

function splitPluralKey(key: string): { base: string; category: string } | null {
	for (const suffix of PLURAL_SUFFIXES) {
		const tail = `_${suffix}`

		if (key.endsWith(tail) && key.length > tail.length) {
			return { base: key.slice(0, -tail.length), category: suffix }
		}
	}

	return null
}

// Bases that form a real i18next plural group in the English catalog (have BOTH `_one` and `_other`),
// mapped to the CLDR categories English provides. Guards against false positives like a lone key that
// merely ends in `_one`.
const ENGLISH_PLURAL_BASES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
	const bases = new Map<string, Set<string>>()

	for (const key of Object.keys(EN_CATALOG)) {
		const split = splitPluralKey(key)

		if (split === null) {
			continue
		}

		const categories = bases.get(split.base) ?? new Set<string>()

		categories.add(split.category)
		bases.set(split.base, categories)
	}

	for (const [base, categories] of bases) {
		if (!(categories.has("one") && categories.has("other"))) {
			bases.delete(base)
		}
	}

	return bases
})()

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
	args: Args,
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

function buildSystemPrompt(englishSource: string): string {
	return [
		"You are a professional software localizer translating the user-interface strings of Filen,",
		"an end-to-end-encrypted cloud storage mobile app. You translate from English into the target",
		"language named in each user message. Return only natural, idiomatic translations suitable for",
		"a native speaker using the app.",
		"",
		"Every key in the source catalog below carries a /** JSDoc */ comment describing where and how it",
		"is used (button, screen title, status badge, confirmation message, …). READ that context before",
		"translating — most of the rules below can only be applied correctly once you know the key's role.",
		"",
		"STRICT RULES — follow every one:",
		"1. Do NOT translate the brand names \"Filen\" and \"Filen.io\" — keep them verbatim.",
		"2. Preserve every interpolation placeholder EXACTLY as written, including the double braces:",
		"   `{{count}}`, `{{name}}`, `{{used}}`, `{{max}}`, etc. Never translate, reorder the braces, add",
		"   spaces inside them, or localize the placeholder name. You MAY move a placeholder within the",
		"   sentence if the target grammar requires it, but the token stays byte-identical AND keeps its",
		"   role: when two placeholders carry distinct meanings (e.g. `{{used}}` of `{{max}}`), never swap",
		"   which is which — keep the source's relative order unless grammar forces otherwise.",
		"3. Preserve react-i18next markup tags EXACTLY: `<link>…</link>` and any other `<tag>…</tag>`.",
		"   Translate the text BETWEEN the tags, never the tag names, and keep them balanced.",
		"4. Plural keys come as separate entries ending in `_one` / `_other` (and occasionally `_zero`,",
		"   `_few`, `_many`). Translate each as its own entry — do not merge or drop any. Use the correct",
		"   plural form for the target language even when English repeats the same wording. For languages",
		"   with more plural categories than English (Russian, Ukrainian, Polish, Czech, …), the `_other`",
		"   form must use the case that language requires for large/varied counts — in Slavic languages the",
		"   genitive plural (e.g. Russian `{{count}} файлов`, NOT the nominative `{{count}} файлы`).",
		"5. Keep technical tokens, file extensions, units, and format specifiers intact (\"PDF\", \"MB/s\",",
		"   \"2FA\", \"URL\"). Mirror the source's deliberate wording: render user-facing paraphrases by",
		"   meaning (\"sandbox cache\" → \"temporary cache\"), and keep the app's standard term the source",
		"   chose (it says \"directory\", not the generic \"folder\").",
		"6. Match the source register and length where possible — these are compact mobile UI labels.",
		"   Do not add explanations, quotes, or trailing punctuation that the source lacks.",
		"7. Return ONLY a JSON object mapping each input key to its translated string. No commentary.",
		"",
		"MEANING & GRAMMAR — the JSDoc tells you each key's role; honor it:",
		"8. Never invert or weaken meaning, above all for destructive or irreversible actions",
		"   (delete / remove / empty / disable / leave). \"Leave\" a shared note or chat means STOP being a",
		"   participant — use the departure verb, never the verb for \"keep / let remain\".",
		"9. Match the part of speech to the UI role. A button or menu action is an imperative verb: when",
		"   English is a verb used as a label (\"Empty\", \"Trash\", \"Favorite\", \"Duplicate\"), the translation",
		"   must be a verb/action phrase, never an adjective or bare noun (the French empty-trash button is",
		"   \"Vider\", not the adjective \"Vide\"). A status badge keeps its full meaning (\"Available offline\",",
		"   not bare \"Offline\"). A screen or section title naming a collection is a plural noun phrase. A",
		"   standalone picker/option label (e.g. Light / Dark / System) must be a noun or nominal form that",
		"   can stand alone — never an adverb or bare verb stem (Korean \"Light\" is the noun 밝음, not the",
		"   adverb 밝게).",
		"10. Translate the ACTION, not a description of state. A header for tagging selected notes is \"Tag",
		"    selected notes\" (what the user is DOING), not \"Tags of selected notes\" (what they are viewing).",
		"    Name both the verb and the object type the action operates on.",
		"11. The app speaks in the user's own first person. Sections of the user's content read \"Shared with",
		"    me\" / \"received by me\" — never the second person (\"shared with you\").",
		"12. Preserve prepositional complements: \"Remove from offline\", never \"Remove offline\"; do not drop",
		"    a \"from <X>\" / \"to <X>\".",
		"13. A list placeholder such as `{{names}}` holds a pre-joined string of names, NOT a numeric count —",
		"    i18next plural selection does not fire on it, so conjugate the surrounding verb as SINGULAR",
		"    unless the JSDoc states the value is always plural.",
		"14. Rating-scale tiers (e.g. password strength Weak / Fair / Strong / Very strong) map to the same",
		"    relative rank in the target language. Do not use generic superlatives (\"best\", \"excellent\")",
		"    that collapse the top tiers.",
		"15. You may be asked for plural entries ending in `_few` or `_many` that have NO matching English",
		"    key — CLDR categories your language needs but English lacks. The English text shown is the",
		"    `_other` template; produce the correct form for that category's count range (`_few` ≈ small",
		"    counts, e.g. 2–4 in Slavic, 2–19 in Romanian; `_many` ≈ large/other counts), inflecting the noun",
		"    and agreeing adjectives into the right case (Slavic: `_few` → genitive singular, `_many` →",
		"    genitive plural). Keep every `{{placeholder}}` byte-identical.",
		"",
		"The full English source catalog follows, WITH its JSDoc comments, so you can see exactly where",
		"and how each key is used. Use it as context; only translate the keys requested in each message.",
		"",
		"===== BEGIN ENGLISH SOURCE CATALOG =====",
		englishSource,
		"===== END ENGLISH SOURCE CATALOG ====="
	].join("\n")
}

// DRY_RUN stub: prefix every English value with the lang code. Obvious, deterministic, free.
function translateDryRun(lang: TargetLanguage, subset: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {}

	for (const [key, value] of Object.entries(subset)) {
		result[key] = `${lang}:${value}`
	}

	return result
}

// Closed JSON schema with one string-valued property per requested key. Anthropic structured output
// (output_config.format) requires `additionalProperties: false` — an open `{ type: "string" }` map
// is rejected with a 400 — so the exact keys are declared explicitly and all are required.
function buildOutputSchema(keys: readonly string[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {}

	for (const key of keys) {
		properties[key] = {
			type: "string"
		}
	}

	return {
		type: "object",
		additionalProperties: false,
		properties,
		required: [...keys]
	}
}

// Max keys per Anthropic request. The full catalog (~764 keys) in a single response can exceed
// max_tokens for verbose languages (German/Russian/Japanese/Chinese) → a truncated JSON body that
// fails to parse and aborts that language. Batching keeps every response well under max_tokens; the
// cached system prefix (English source + glossary) is identical across all batches and languages,
// so each extra batch is a cheap cache READ, not a re-send of the big prefix.
const BATCH_SIZE = 100

function chunkEntries(subset: Record<string, string>, size: number): Record<string, string>[] {
	const entries = Object.entries(subset)
	const chunks: Record<string, string>[] = []

	for (let start = 0; start < entries.length; start += size) {
		const chunk: Record<string, string> = {}

		for (const [key, value] of entries.slice(start, start + size)) {
			chunk[key] = value
		}

		chunks.push(chunk)
	}

	return chunks
}

// Translate one language's full subset by splitting it into BATCH_SIZE chunks, translating each, and
// merging. Throws if the model omits any requested key (a truncated/partial batch surfaces as an
// error rather than silently writing an incomplete catalog).
async function translateSubset(args: {
	client: Anthropic
	lang: TargetLanguage
	subset: Record<string, string>
	systemPrompt: string
}): Promise<Record<string, string>> {
	const { client, lang, subset, systemPrompt } = args
	const batches = chunkEntries(subset, BATCH_SIZE)
	const result: Record<string, string> = {}

	for (let index = 0; index < batches.length; index++) {
		const batch = batches[index]

		if (batch === undefined) {
			continue
		}

		console.log(`[translate-i18n] ${lang}: batch ${index + 1}/${batches.length} (${Object.keys(batch).length} keys)`)

		const translated = await translateBatch({
			client,
			lang,
			batch,
			systemPrompt
		})

		Object.assign(result, translated)
	}

	for (const key of Object.keys(subset)) {
		if (!(key in result)) {
			throw new Error(`${lang}: model did not return a translation for key "${key}"`)
		}
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

function writeCatalog(lang: TargetLanguage, catalog: Record<string, string>): void {
	const sorted: Record<string, string> = {}

	for (const key of Object.keys(catalog).sort()) {
		const value = catalog[key]

		if (value !== undefined) {
			sorted[key] = value
		}
	}

	const json = `${JSON.stringify(sorted, null, "\t")}\n`

	writeFileSync(join(LOCALES_DIR, `${lang}.json`), json, "utf8")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const delta = args.full ? { upsert: {}, removed: [] } : computeDelta()
	const englishSource = readEnglishSourceFiles()
	const systemPrompt = buildSystemPrompt(englishSource)

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
		const existing = readTargetCatalog(lang)
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
						client: client as Anthropic,
						lang,
						subset,
						systemPrompt
					})

			Object.assign(merged, translated)
		} else {
			console.log(`[translate-i18n] ${lang}: nothing to translate`)
		}

		writeCatalog(lang, merged)

		console.log(`[translate-i18n] ${lang}: wrote ${Object.keys(merged).length} keys`)
	}

	console.log("[translate-i18n] done")
}

main().catch(error => {
	// Surface a clean message; never echo the API key.
	console.error("[translate-i18n] failed:", error instanceof Error ? error.message : String(error))
	process.exit(1)
})
