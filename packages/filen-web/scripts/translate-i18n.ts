// i18n translation pipeline — fills the target-language catalogs (src/locales/<lang>.json)
// from the English source catalogs (src/locales/en/*.ts) via the Anthropic Messages API.
//
// The English source is split across real i18next namespaces (currently `common`, `errors`, `auth`,
// `drive`) — each namespace file exports its own `as const` object. Every target-language catalog nests
// translations under the same namespace keys, e.g. `{ "common": {...}, "errors": {...} }`.
//
// Run with: npm run translate-i18n            (DELTA mode — only changed English keys)
//           npm run translate-i18n -- --full  (FULL mode — every key for every language)
//           npm run translate-i18n -- de      (restrict to specific languages)
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

import { common } from "@/locales/en/common"
import { errors } from "@/locales/en/errors"
import { auth } from "@/locales/en/auth"
import { drive } from "@/locales/en/drive"

// NOTE: do NOT import from `@/lib/i18n` here — its index module runs
// `i18n.use(initReactI18next).init(...)` as an import-time side effect the moment it's loaded,
// which this script has no reason to trigger. Import the namespace catalogs directly
// (`@/locales/en/common`, `@/locales/en/errors`, `@/locales/en/auth`, `@/locales/en/drive`) instead
// — that's what EN_CATALOG below does.
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

const NAMESPACES = ["common", "errors", "auth", "drive"] as const

type Namespace = (typeof NAMESPACES)[number]

// One flat key→value map per namespace; every value is a string (plural keys are separate
// `_one`/`_other` entries). Unlike mobile's single merged `en` barrel, keys only need to be unique
// WITHIN a namespace — this mirrors the app's real i18next config (keySeparator/nsSeparator ON,
// real namespaces), so the delta/plural/translation machinery below is scoped per namespace.
const EN_CATALOG: Record<Namespace, Record<string, string>> = {
	common,
	errors,
	auth,
	drive
}

const DRY_RUN = process.env["DRY_RUN"] === "1"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
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

		// Accept a bare or comma-separated language list, e.g. `de` (or `de,fr` once more
		// languages are enabled).
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
	return {
		common: { upsert: {}, removed: [] },
		errors: { upsert: {}, removed: [] },
		auth: { upsert: {}, removed: [] },
		drive: { upsert: {}, removed: [] }
	}
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

// Read the English snapshot (the DELTA baseline) — the catalog as of the last translation, nested
// by namespace like the target catalogs. Returns null when absent (first run / not yet seeded) so
// the caller re-baselines instead of retranslating everything; throws on a malformed file so a
// corrupt baseline fails loudly rather than silently re-translating the whole catalog.
function readSnapshot(): Record<Namespace, Record<string, string>> | null {
	if (!existsSync(EN_SNAPSHOT_PATH)) {
		return null
	}

	const raw = readFileSync(EN_SNAPSHOT_PATH, "utf8").trim()

	if (raw.length === 0) {
		return null
	}

	const parsed: unknown = JSON.parse(raw)

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(".en-snapshot.json is not a JSON object")
	}

	const record = parsed as Record<string, unknown>

	return {
		common: readNamespaceRecord(record, "common", ".en-snapshot.json"),
		errors: readNamespaceRecord(record, "errors", ".en-snapshot.json"),
		auth: readNamespaceRecord(record, "auth", ".en-snapshot.json"),
		drive: readNamespaceRecord(record, "drive", ".en-snapshot.json")
	}
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

	return {
		common: computeNamespaceDelta(snapshot.common, EN_CATALOG.common),
		errors: computeNamespaceDelta(snapshot.errors, EN_CATALOG.errors),
		auth: computeNamespaceDelta(snapshot.auth, EN_CATALOG.auth),
		drive: computeNamespaceDelta(snapshot.drive, EN_CATALOG.drive)
	}
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
	const path = join(LOCALES_DIR, `${lang}.json`)

	if (!existsSync(path)) {
		return { common: {}, errors: {}, auth: {}, drive: {} }
	}

	const raw = readFileSync(path, "utf8").trim()

	if (raw.length === 0) {
		return { common: {}, errors: {}, auth: {}, drive: {} }
	}

	const parsed: unknown = JSON.parse(raw)

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Catalog ${lang}.json is not a JSON object`)
	}

	const record = parsed as Record<string, unknown>
	const fileLabel = `Catalog ${lang}.json`

	return {
		common: readNamespaceRecord(record, "common", fileLabel),
		errors: readNamespaceRecord(record, "errors", fileLabel),
		auth: readNamespaceRecord(record, "auth", fileLabel),
		drive: readNamespaceRecord(record, "drive", fileLabel)
	}
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

// Bases that form a real i18next plural group in one namespace's English catalog (have BOTH
// `_one` and `_other`), mapped to the CLDR categories English provides. Guards against false
// positives like a lone key that merely ends in `_one`. Computed per namespace — a plural base is
// scoped to its own namespace, never merged across namespaces.
function computePluralBases(catalog: Record<string, string>): ReadonlyMap<string, ReadonlySet<string>> {
	const bases = new Map<string, Set<string>>()

	for (const key of Object.keys(catalog)) {
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
}

const ENGLISH_PLURAL_BASES: Record<Namespace, ReadonlyMap<string, ReadonlySet<string>>> = {
	common: computePluralBases(EN_CATALOG.common),
	errors: computePluralBases(EN_CATALOG.errors),
	auth: computePluralBases(EN_CATALOG.auth),
	drive: computePluralBases(EN_CATALOG.drive)
}

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
	args: Args,
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

function buildSystemPrompt(englishSource: string): string {
	return [
		"You are a professional software localizer translating the user-interface strings of Filen,",
		"an end-to-end-encrypted cloud storage web app. You translate from English into the target",
		"language named in each user message. Return only natural, idiomatic translations suitable for",
		"a native speaker using the app.",
		"",
		"Every key in the source catalog below carries a /** JSDoc */ comment describing where and how it",
		"is used (button, screen title, status badge, confirmation message, …). READ that context before",
		"translating — most of the rules below can only be applied correctly once you know the key's role.",
		"",
		"STRICT RULES — follow every one:",
		'1. Do NOT translate the brand names "Filen" and "Filen.io" — keep them verbatim.',
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
		'5. Keep technical tokens, file extensions, units, and format specifiers intact ("PDF", "MB/s",',
		'   "2FA", "URL"). Mirror the source\'s deliberate wording: render user-facing paraphrases by',
		'   meaning ("sandbox cache" → "temporary cache"), and keep the app\'s standard term the source',
		'   chose (it says "directory", not the generic "folder").',
		"6. Match the source register and length where possible — these are compact UI labels. Do not add",
		"   explanations, quotes, or trailing punctuation that the source lacks.",
		"7. Return ONLY a JSON object mapping each input key to its translated string. No commentary.",
		"",
		"MEANING & GRAMMAR — the JSDoc tells you each key's role; honor it:",
		"8. Never invert or weaken meaning, above all for destructive or irreversible actions",
		'   (delete / remove / empty / disable / leave). "Leave" a shared note or chat means STOP being a',
		'   participant — use the departure verb, never the verb for "keep / let remain".',
		"9. Match the part of speech to the UI role. A button or menu action is an imperative verb: when",
		'   English is a verb used as a label ("Empty", "Trash", "Favorite", "Duplicate"), the translation',
		"   must be a verb/action phrase, never an adjective or bare noun (the French empty-trash button is",
		'   "Vider", not the adjective "Vide"). A status badge keeps its full meaning ("Available offline",',
		'   not bare "Offline"). A screen or section title naming a collection is a plural noun phrase. A',
		"   standalone picker/option label (e.g. Light / Dark / System) must be a noun or nominal form that",
		'   can stand alone — never an adverb or bare verb stem (Korean "Light" is the noun 밝음, not the',
		"   adverb 밝게).",
		'10. Translate the ACTION, not a description of state. A header for tagging selected notes is "Tag',
		'    selected notes" (what the user is DOING), not "Tags of selected notes" (what they are viewing).',
		"    Name both the verb and the object type the action operates on.",
		"11. The app speaks in the user's own first person. Sections of the user's content read \"Shared with",
		'    me" / "received by me" — never the second person ("shared with you").',
		'12. Preserve prepositional complements: "Remove from offline", never "Remove offline"; do not drop',
		'    a "from <X>" / "to <X>".',
		"13. A list placeholder such as `{{names}}` holds a pre-joined string of names, NOT a numeric count —",
		"    i18next plural selection does not fire on it, so conjugate the surrounding verb as SINGULAR",
		"    unless the JSDoc states the value is always plural.",
		"14. Rating-scale tiers (e.g. password strength Weak / Fair / Strong / Very strong) map to the same",
		'    relative rank in the target language. Do not use generic superlatives ("best", "excellent")',
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

// Max keys per Anthropic request. Two independent limits force small batches:
//   1. max_tokens — a large catalog in one response can exceed max_tokens for verbose languages
//      (German/Russian/Japanese/Chinese), truncating the JSON body so it fails to parse.
//   2. Structured-output grammar size — buildOutputSchema declares one required property per key, and
//      Anthropic compiles that closed schema into a constrained-decoding grammar whose size grows
//      with the key count. Past a few dozen keys it is rejected with 400 "compiled grammar is too
//      large". Small batches keep the per-request grammar well under that limit.
// Extra batches are cheap: the cached system prefix (English source + glossary) is identical across
// every batch and language, so each extra batch is a cache READ, not a re-send of the big prefix.
const BATCH_SIZE = 25

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

// Translate one language's full subset (for one namespace) by splitting it into BATCH_SIZE chunks,
// translating each, and merging. Throws if the model omits any requested key (a truncated/partial
// batch surfaces as an error rather than silently writing an incomplete catalog).
async function translateSubset(args: {
	client: Anthropic
	lang: TargetLanguage
	ns: Namespace
	subset: Record<string, string>
	systemPrompt: string
}): Promise<Record<string, string>> {
	const { client, lang, ns, subset, systemPrompt } = args
	const batches = chunkEntries(subset, BATCH_SIZE)
	const result: Record<string, string> = {}

	for (let index = 0; index < batches.length; index++) {
		const batch = batches[index]

		if (batch === undefined) {
			continue
		}

		console.log(
			`[translate-i18n] ${lang}/${ns}: batch ${String(index + 1)}/${String(batches.length)} (${String(Object.keys(batch).length)} keys)`
		)

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
			throw new Error(`${lang}/${ns}: model did not return a translation for key "${key}"`)
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

function sortRecord(record: Record<string, string>): Record<string, string> {
	const sorted: Record<string, string> = {}

	for (const key of Object.keys(record).sort()) {
		const value = record[key]

		if (value !== undefined) {
			sorted[key] = value
		}
	}

	return sorted
}

function writeCatalog(lang: TargetLanguage, catalog: Record<Namespace, Record<string, string>>): void {
	const sorted: Record<Namespace, Record<string, string>> = {
		common: sortRecord(catalog.common),
		errors: sortRecord(catalog.errors),
		auth: sortRecord(catalog.auth),
		drive: sortRecord(catalog.drive)
	}

	const json = `${JSON.stringify(sorted, null, "\t")}\n`

	writeFileSync(join(LOCALES_DIR, `${lang}.json`), json, "utf8")
}

// Rewrite the snapshot to the current English catalog (sorted + trailing newline, like the target
// catalogs, and nested by namespace the same way) so the next DELTA diffs against this state. Written
// into the same PR as the translations, so the baseline only advances once that PR is merged — an
// unmerged run keeps re-detecting the same delta.
function writeSnapshot(): void {
	const sorted: Record<Namespace, Record<string, string>> = {
		common: sortRecord(EN_CATALOG.common),
		errors: sortRecord(EN_CATALOG.errors),
		auth: sortRecord(EN_CATALOG.auth),
		drive: sortRecord(EN_CATALOG.drive)
	}

	const json = `${JSON.stringify(sorted, null, "\t")}\n`

	writeFileSync(EN_SNAPSHOT_PATH, json, "utf8")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const delta = args.full ? emptyDelta() : computeDelta()
	const englishSource = readEnglishSourceFiles()
	const systemPrompt = buildSystemPrompt(englishSource)
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
		const merged: Record<Namespace, Record<string, string>> = {
			common: { ...existing.common },
			errors: { ...existing.errors },
			auth: { ...existing.auth },
			drive: { ...existing.drive }
		}

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
								client,
								lang,
								ns,
								subset,
								systemPrompt
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
