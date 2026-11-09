/**
 * The core of the apps' translate-i18n scripts: CLI parsing and the time budget, the English-vs-snapshot delta, CLDR
 * plural expansion, the per-language key plan and the FULL resume record, removals, the translator system prompt, the
 * request and its structured-output schema, batching with retries and validation, and reading a batch's reply. Every function works on one flat key → string catalog (mobile has one, the
 * web app one per namespace). Each script keeps its catalog files, prompt context and Anthropic client, which it
 * passes in as `createMessage`, so this module needs no SDK. Node-only build tooling, reachable solely through the
 * "@filen/shared/tooling/i18n" subpath so it never enters an app bundle.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { type } from "arktype"

export type Catalog = Record<string, string>

/**
 * English names of the target languages, telling the model what to translate into. Keyed by the literal codes, so a
 * script indexing it with a language of @filen/shared/languages fails to compile when one is missing here.
 */
export const LANGUAGE_NAMES = {
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
} as const

export type CliArgs<L extends string> = {
	full: boolean
	languages: readonly L[]
	// Minutes the run may spend before it stops at the next batch boundary; null = unbounded.
	budgetMinutes: number | null
}

const BUDGET_FLAG = "--budget-minutes="

/**
 * `--full`, `--budget-minutes=<n>` (decimals allowed, 0 = translate nothing) plus a bare or comma-separated language
 * list, e.g. `de` or `de,fr,ja`. No list means every language.
 */
export function parseCliArgs<L extends string>(argv: readonly string[], allowed: readonly L[]): CliArgs<L> {
	let full = false
	let budgetMinutes: number | null = null
	const requested: L[] = []

	for (const arg of argv) {
		if (arg === "--full") {
			full = true

			continue
		}

		if (arg.startsWith(BUDGET_FLAG)) {
			const raw = arg.slice(BUDGET_FLAG.length)
			const value = Number(raw)

			if (raw.trim().length === 0 || !Number.isFinite(value) || value < 0) {
				throw new Error(`Invalid ${BUDGET_FLAG}${raw}: expected a non-negative number of minutes`)
			}

			budgetMinutes = value

			continue
		}

		for (const candidate of arg.split(",")) {
			const trimmed = candidate.trim()

			if (trimmed.length === 0) {
				continue
			}

			const match = allowed.find(lang => lang === trimmed)

			if (match === undefined) {
				throw new Error(`Unknown target language "${trimmed}". Valid: ${allowed.join(", ")}`)
			}

			requested.push(match)
		}
	}

	return {
		full,
		languages: requested.length > 0 ? requested : allowed,
		budgetMinutes
	}
}

/**
 * The process exit code of a run that stopped because its time budget ran out. Everything translated so far is on
 * disk; re-running the same command continues from there. Distinct from 1 (failure) so a CI job can tell the two
 * apart.
 */
export const BUDGET_EXHAUSTED_EXIT_CODE = 3

/** A stop check for `minutes` from now (never true for null; true at once for 0). */
export function deadlineAfter(minutes: number | null, now: () => number = Date.now): () => boolean {
	if (minutes === null) {
		return () => false
	}

	const end = now() + minutes * 60_000

	return () => now() >= end
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

export const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const

const cldrCategoriesCache = new Map<string, readonly string[]>()

/**
 * The plural categories an INTEGER count can actually select for this language. Sampling 0..200 covers
 * every modulo-10 / modulo-100 CLDR rule (Slavic few/many cycles, Romanian few = 0 or n%100 in 1..19)
 * while excluding decimal-only and millions-only categories. `_one` / `_other` are kept regardless,
 * because the callers union this with the categories English itself defines.
 */
export function cldrCategories(lang: string): readonly string[] {
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

export function splitPluralKey(key: string): { base: string; category: string } | null {
	for (const suffix of PLURAL_SUFFIXES) {
		const tail = `_${suffix}`

		if (key.endsWith(tail) && key.length > tail.length) {
			return { base: key.slice(0, -tail.length), category: suffix }
		}
	}

	return null
}

/**
 * Bases that form a real i18next plural group in an English catalog (have BOTH `_one` and `_other`),
 * mapped to the CLDR categories English provides. Guards against false positives like a lone key that
 * merely ends in `_one`.
 */
export function computePluralBases(catalog: Record<string, string>): ReadonlyMap<string, ReadonlySet<string>> {
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

// --- Translation -----------------------------------------------------------

/**
 * The stable, cached system prefix: instructions plus the JSDoc-rich English source. `product`
 * names the app the strings belong to ("mobile" / "web"). `partial` says the source is only the part of the catalog
 * the requested keys come from (plus shared terms), not all of it.
 */
export function buildSystemPrompt(englishSource: string, product: string, partial = false): string {
	return [
		"You are a professional software localizer translating the user-interface strings of Filen,",
		`an end-to-end-encrypted cloud storage ${product} app. You translate from English into the target`,
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
		`6. Match the source register and length where possible — these are compact ${product} UI labels.`,
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
		...(partial
			? [
					"The English source files the requested keys come from follow, WITH their JSDoc comments, together",
					"with the app's shared common strings, so you can see exactly where and how each key is used. Use them",
					"as context and keep the common strings' terminology; only translate the keys requested in each message."
				]
			: [
					"The full English source catalog follows, WITH its JSDoc comments, so you can see exactly where",
					"and how each key is used. Use it as context; only translate the keys requested in each message."
				]),
		"",
		"===== BEGIN ENGLISH SOURCE CATALOG =====",
		englishSource,
		"===== END ENGLISH SOURCE CATALOG ====="
	].join("\n")
}

/**
 * Closed JSON schema with one string-valued property per requested key. Anthropic structured output
 * (output_config.format) requires `additionalProperties: false` — an open `{ type: "string" }` map
 * is rejected with a 400 — so the exact keys are declared explicitly and all are required.
 */
export function buildOutputSchema(keys: readonly string[]): Record<string, unknown> {
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

export function chunkEntries(subset: Record<string, string>, size: number): Record<string, string>[] {
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

/**
 * A reply that came back but cannot be used: a missing key, placeholders or markup that differ from English, an early
 * stop or unparseable output. Retried once (the model may well get it right the second time), then fatal.
 */
export class TranslationValidationError extends Error {
	override name = "TranslationValidationError"
}

/** Attempts per batch for transient failures (rate limit, overload, 5xx, network). */
export const MAX_TRANSIENT_ATTEMPTS = 4

/** Attempts per batch for validation failures. */
export const MAX_VALIDATION_ATTEMPTS = 2

const TRANSIENT_STATUSES = new Set([408, 409, 429])
const TRANSIENT_MESSAGE = /overloaded|rate.?limit|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i

/**
 * Whether a failed request is worth retrying: an HTTP 408/409/429/5xx (Anthropic's overload is 529), a connection
 * error or timeout, or an overload/network message. Structural, so this module needs no SDK: the SDK's errors carry
 * `status` and are named APIConnectionError / APIConnectionTimeoutError.
 */
export function isTransientError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false
	}

	const status: unknown = Reflect.get(error, "status")

	if (typeof status === "number" && (TRANSIENT_STATUSES.has(status) || status >= 500)) {
		return true
	}

	return error.name.startsWith("APIConnection") || TRANSIENT_MESSAGE.test(error.message)
}

/** Backoff before transient retry n (1-based): 5 s, 15 s, 45 s, capped at a minute. */
export function retryDelayMs(retry: number): number {
	return Math.min(60_000, 5_000 * 3 ** (retry - 1))
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * What is wrong with a batch reply, one line per problem: requested keys it lacks, and placeholder or markup sets that
 * differ from the English text sent (a `_one` form may leave out `{{count}}`). The per-batch counterpart of
 * catalogIssues, so a bad reply is retried instead of reaching a catalog.
 */
export function batchIssues(batch: Catalog, reply: Catalog): string[] {
	const issues: string[] = []

	for (const [key, english] of Object.entries(batch)) {
		const value = reply[key]

		if (value === undefined) {
			issues.push(`model did not return a translation for key "${key}"`)

			continue
		}

		const expected = placeholderSet(english)
		const actual = placeholderSet(value)

		if (splitPluralKey(key)?.category === "one") {
			expected.delete("count")
			actual.delete("count")
		}

		if (!sameSet(expected, actual)) {
			issues.push(`${key}: placeholders ${[...actual].join(",")} differ from English ${[...expected].join(",")}`)
		}

		if (!sameSet(markupSet(english), markupSet(value))) {
			issues.push(`${key}: markup differs from English`)
		}
	}

	return issues
}

/**
 * Translates a subset batch by batch through the caller's model call. Each validated batch goes to `onBatch` at once
 * (only the requested keys), so the caller can checkpoint it and a later failure keeps everything already paid for.
 * A transient failure is retried with backoff up to MAX_TRANSIENT_ATTEMPTS, a validation failure once; anything else,
 * or a failure past its attempts, throws. `shouldStop` is checked before every batch and instead of a backoff wait:
 * true ends the subset early. Resolves true when every batch was translated, false when stopped. `label` prefixes the
 * log lines and errors (e.g. "de" or "de/common").
 */
export async function translateSubset({
	label,
	subset,
	translateBatch,
	onBatch,
	shouldStop = () => false,
	sleep = defaultSleep
}: {
	label: string
	subset: Catalog
	translateBatch: (batch: Catalog) => Promise<Catalog>
	onBatch: (translated: Catalog) => void
	shouldStop?: () => boolean
	sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
	const batches = chunkEntries(subset, BATCH_SIZE)

	for (let index = 0; index < batches.length; index++) {
		const batch = batches[index]

		if (batch === undefined) {
			continue
		}

		const name = `${label}: batch ${index + 1}/${batches.length}`
		let transientFailures = 0
		let validationFailures = 0
		let translated: Catalog | null = null

		while (translated === null) {
			if (shouldStop()) {
				return false
			}

			console.log(`[translate-i18n] ${name} (${Object.keys(batch).length} keys)`)

			try {
				const reply = await translateBatch(batch)
				const issues = batchIssues(batch, reply)

				if (issues.length > 0) {
					throw new TranslationValidationError(issues.join("; "))
				}

				translated = {}

				for (const key of Object.keys(batch)) {
					translated[key] = reply[key] ?? ""
				}
			} catch (error) {
				if (error instanceof TranslationValidationError) {
					validationFailures++

					if (validationFailures >= MAX_VALIDATION_ATTEMPTS) {
						throw new Error(`${name}: ${error.message}`, { cause: error })
					}

					console.warn(`[translate-i18n] ${name}: invalid reply (${error.message}); retrying`)

					continue
				}

				if (!isTransientError(error)) {
					throw error
				}

				transientFailures++

				if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
					throw new Error(`${name}: gave up after ${MAX_TRANSIENT_ATTEMPTS} attempts: ${errorMessage(error)}`, { cause: error })
				}

				// Out of time: stop now rather than wait out a backoff the budget no longer has.
				if (shouldStop()) {
					return false
				}

				const delay = retryDelayMs(transientFailures)

				console.warn(`[translate-i18n] ${name}: transient failure (${errorMessage(error)}); retry in ${delay / 1000}s`)

				await sleep(delay)
			}
		}

		onBatch(translated)
	}

	return true
}

/** Copy with keys in sorted order, for stable catalog diffs. */
export function sortRecord(record: Record<string, string>): Record<string, string> {
	const sorted: Record<string, string> = {}

	for (const key of Object.keys(record).sort()) {
		const value = record[key]

		if (value !== undefined) {
			sorted[key] = value
		}
	}

	return sorted
}

const translatedBatch = type({
	"[string]": "string"
})

/** A batch's reply text: a JSON map of keys to translated strings. Throws on anything else. */
export function parseTranslatedBatch(text: string): Record<string, string> {
	const parsed: unknown = JSON.parse(text)

	// arktype counts an array as an object.
	if (Array.isArray(parsed)) {
		throw new Error("Translation reply is an array, not a JSON map")
	}

	return translatedBatch.assert(parsed)
}

// --- Catalog files ---------------------------------------------------------

/**
 * A JSON file holding a plain object, or null when it is absent or blank. Throws on any other shape, so a corrupt
 * catalog or snapshot fails loudly instead of silently re-translating everything.
 */
export function readJsonObject(path: string, label: string): Record<string, unknown> | null {
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

/**
 * Tab-indented JSON plus a trailing newline, for stable diffs. Written to a temporary file and renamed over the target,
 * so a run killed mid-write (a CI job cancelled at its time limit) never leaves a truncated catalog. Creates the
 * directory when needed.
 */
export function writeJsonFile(path: string, value: unknown): void {
	const temporary = `${path}.tmp`

	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, "utf8")
	renameSync(temporary, path)
}

// --- Delta -----------------------------------------------------------------

export type Delta = {
	// Keys whose English value was added or changed → (re)translate for every target.
	upsert: Catalog
	// Keys removed from English → delete from every target catalog.
	removed: readonly string[]
}

export function emptyDelta(): Delta {
	return {
		upsert: {},
		removed: []
	}
}

/**
 * The English catalog diffed against the snapshot of the last translation. A key whose value changed (or a key absent
 * from the snapshot) is an upsert; a snapshot key no longer in English is a removal. Content-based, so a changed value
 * is caught whichever commit it landed in. With no snapshot, an empty delta: the missing-key safety net in
 * keysToTranslate still fills every absent key.
 */
export function computeDelta(snapshot: Catalog | null, catalog: Catalog): Delta {
	const upsert: Catalog = {}
	const removed: string[] = []

	if (snapshot === null) {
		return {
			upsert,
			removed
		}
	}

	for (const [key, value] of Object.entries(catalog)) {
		if (snapshot[key] !== value) {
			upsert[key] = value
		}
	}

	for (const key of Object.keys(snapshot)) {
		if (!(key in catalog)) {
			removed.push(key)
		}
	}

	return {
		upsert,
		removed
	}
}

/**
 * Deletes the removed keys from a target catalog in place. A removed plural variant drops every CLDR-category
 * sibling, including target-only `_few` / `_many` that never appear in the English diff. Run before merging new
 * translations, so a key removed and re-added in one delta nets to the new value.
 */
export function applyRemovals(target: Catalog, removed: readonly string[]): void {
	for (const key of removed) {
		Reflect.deleteProperty(target, key)

		const split = splitPluralKey(key)

		if (split !== null) {
			for (const suffix of PLURAL_SUFFIXES) {
				Reflect.deleteProperty(target, `${split.base}_${suffix}`)
			}
		}
	}
}

/**
 * Whether a run may advance the snapshot: only when it covered every target language. Advanced after a subset run,
 * the languages left out would never see the changed keys again (only missing ones are recovered).
 */
export function coversEveryLanguage<L extends string>(requested: readonly L[], all: readonly L[]): boolean {
	const set = new Set(requested)

	return all.every(lang => set.has(lang))
}

// --- Resume record ---------------------------------------------------------
//
// Per target language, the English text each key was translated from, so a FULL run that stopped (a failure, a time
// budget, a CI job limit) resumes where it left off instead of paying for the same keys again. Stored as a short hash
// of the English (key → hash) in `src/locales/.sources/<lang>.json` (a dot directory, never served or bundled). A run
// that completes for every language deletes the directory along with advancing the snapshot, so the next FULL run
// translates everything again.

export type SourceRecord = Record<string, string>

/** The resume records' directory, inside the locales directory. */
export const SOURCES_DIR_NAME = ".sources"

const sourceHashCache = new Map<string, string>()

/** 64 bits of the SHA-256 of an English string: equality only, so collisions between a key's versions are moot. */
export function sourceHash(english: string): string {
	const cached = sourceHashCache.get(english)

	if (cached !== undefined) {
		return cached
	}

	const hash = createHash("sha256").update(english).digest("hex").slice(0, 16)

	sourceHashCache.set(english, hash)

	return hash
}

/** Records, in place, the English each translated key came from (`subset` holds the text sent for it). */
export function recordSources(record: SourceRecord, translated: Catalog, subset: Catalog): void {
	for (const key of Object.keys(translated)) {
		const english = subset[key]

		if (english !== undefined) {
			record[key] = sourceHash(english)
		}
	}
}

// --- Per-language plan -----------------------------------------------------

/** An English catalog with its plural groups computed once. */
export type EnglishSource = {
	catalog: Catalog
	pluralBases: ReadonlyMap<string, ReadonlySet<string>>
}

export function englishSource(catalog: Catalog): EnglishSource {
	return {
		catalog,
		pluralBases: computePluralBases(catalog)
	}
}

function pluralBaseOf(source: EnglishSource, key: string): string | null {
	const split = splitPluralKey(key)

	if (split === null) {
		return null
	}

	return source.pluralBases.has(split.base) ? split.base : null
}

/**
 * Every (key → English source text) entry a target language needs for one plural base: the union of the categories
 * English defines and the categories the language requires. Categories English lacks (`_few` / `_many`) use the
 * English `_other` text as the translation template.
 */
export function pluralGroupSources(source: EnglishSource, base: string, lang: string): Catalog {
	const { catalog } = source
	const englishCategories = source.pluralBases.get(base) ?? new Set<string>()
	const categories = new Set<string>([...englishCategories, ...cldrCategories(lang)])
	const template = catalog[`${base}_other`] ?? catalog[`${base}_one`]
	const out: Catalog = {}

	for (const category of categories) {
		const text = catalog[`${base}_${category}`] ?? template

		if (text !== undefined) {
			out[`${base}_${category}`] = text
		}
	}

	return out
}

/**
 * The English keys (key → source text) a language needs translated. FULL = the whole catalog with plural groups
 * expanded to the language's CLDR set, minus what `sources` shows was already translated from the current English
 * (the key is in the target and its recorded hash matches; a plural group is skipped only when every form is). DELTA = changed English keys + non-plural keys missing from the target + the
 * plural categories missing from the target. A changed English plural retranslates its whole group (the wording
 * shifted); a merely incomplete group only fills the missing categories, so reviewed `_one` / `_other` forms are never
 * clobbered.
 */
export function keysToTranslate({
	source,
	full,
	delta,
	existing,
	lang,
	sources = null
}: {
	source: EnglishSource
	full: boolean
	delta: Delta
	existing: Catalog
	lang: string
	// FULL only: the language's resume record; null translates everything.
	sources?: SourceRecord | null
}): Catalog {
	const { catalog } = source
	const result: Catalog = {}

	if (full) {
		const done = (key: string, text: string): boolean => sources !== null && key in existing && sources[key] === sourceHash(text)
		const fullGroups = new Set<string>()

		for (const [key, value] of Object.entries(catalog)) {
			const base = pluralBaseOf(source, key)

			if (base === null) {
				if (!done(key, value)) {
					result[key] = value
				}
			} else {
				fullGroups.add(base)
			}
		}

		// A group is translated as a whole, so its forms stay consistent with one another.
		for (const base of fullGroups) {
			const group = pluralGroupSources(source, base, lang)

			if (Object.entries(group).some(([key, value]) => !done(key, value))) {
				Object.assign(result, group)
			}
		}

		return result
	}

	// A changed plural variant flags its whole group for retranslation.
	const changedGroups = new Set<string>()

	for (const [key, value] of Object.entries(delta.upsert)) {
		const base = pluralBaseOf(source, key)

		if (base === null) {
			result[key] = value
		} else {
			changedGroups.add(base)
		}
	}

	// Non-plural English keys missing from the target (a new stub or a failed earlier run).
	for (const [key, value] of Object.entries(catalog)) {
		if (pluralBaseOf(source, key) !== null) {
			continue
		}

		if (!(key in existing)) {
			result[key] = value
		}
	}

	// Plural groups: the whole group when its English wording changed, otherwise only the CLDR categories the target
	// lacks (this is what supplies `_few` / `_many`).
	for (const base of source.pluralBases.keys()) {
		const sources = pluralGroupSources(source, base, lang)

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

/**
 * The keys of a target catalog (or resume record) that no English key produces: neither an English key nor a form of
 * an English plural group. FULL has no snapshot diff to find removals with, so a resumed run drops these itself;
 * otherwise a key deleted from English while the run was paused would ship in the catalog.
 */
export function staleKeys(source: EnglishSource, target: Catalog): string[] {
	return Object.keys(target).filter(key => !(key in source.catalog) && pluralBaseOf(source, key) === null)
}

/** The number of `english` keys a target catalog holds; the share of the English catalog it covers. */
export function coveredKeyCount(english: Catalog, target: Catalog): number {
	let count = 0

	for (const key of Object.keys(english)) {
		if (key in target) {
			count++
		}
	}

	return count
}

// --- Model call ------------------------------------------------------------

/** DRY_RUN stub: every English value prefixed with the language code ("de:Cancel"). Free and deterministic. */
export function translateDryRun(lang: string, subset: Catalog): Catalog {
	const result: Catalog = {}

	for (const [key, value] of Object.entries(subset)) {
		result[key] = `${lang}:${value}`
	}

	return result
}

type CachedText = {
	type: "text"
	text: string
	cache_control: {
		type: "ephemeral"
	}
}

/** The Messages API request of one batch, structurally; each script passes it to its own SDK client. */
export type BatchRequest = {
	model: string
	max_tokens: number
	betas: string[]
	fallbacks: "default"
	system: CachedText[]
	output_config: {
		effort: "high"
		format: {
			type: "json_schema"
			schema: Record<string, unknown>
		}
	}
	messages: {
		role: "user"
		content: {
			type: "text"
			text: string
		}[]
	}[]
}

export type BatchResponse = {
	stop_reason: string | null
	content: readonly {
		type: string
		text?: string
	}[]
}

export type CreateMessage = (request: BatchRequest) => Promise<BatchResponse>

/**
 * The request of one batch. The cached system blocks (instructions plus English context) are identical across every
 * batch and language that shares them, so only the first call writes the cache; the batch and the language name
 * live in the user message. Thinking is always on for this model and counts against max_tokens; "default" fallbacks
 * route a refused request to another model inside the same call.
 */
export function buildBatchRequest({
	model,
	system,
	languageName,
	batch
}: {
	model: string
	system: readonly string[]
	languageName: string
	batch: Catalog
}): BatchRequest {
	return {
		model,
		max_tokens: 16000,
		betas: ["server-side-fallback-2026-07-01"],
		fallbacks: "default",
		system: system.map(text => ({
			type: "text",
			text,
			cache_control: {
				type: "ephemeral"
			}
		})),
		output_config: {
			effort: "high",
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
	}
}

/** Sends one batch and reads its reply; throws a TranslationValidationError when the reply is unusable. */
export async function translateBatch({
	createMessage,
	model,
	system,
	lang,
	languageName,
	batch
}: {
	createMessage: CreateMessage
	model: string
	system: readonly string[]
	lang: string
	languageName: string
	batch: Catalog
}): Promise<Catalog> {
	const response = await createMessage(buildBatchRequest({ model, system, languageName, batch }))

	if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
		throw new TranslationValidationError(`Translation for ${lang} stopped early (${response.stop_reason})`)
	}

	const block = response.content.find(part => part.type === "text")

	if (block?.text === undefined) {
		throw new TranslationValidationError(`No text content returned for ${lang}`)
	}

	try {
		return parseTranslatedBatch(block.text)
	} catch (error) {
		throw new TranslationValidationError(`Unreadable reply for ${lang}: ${errorMessage(error)}`, { cause: error })
	}
}

// --- Catalog checks (tests of both apps) -----------------------------------

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g
const MARKUP_PATTERN = /<\s*(\/?)\s*([A-Za-z][\w-]*)\s*(\/?)\s*>/g

/** The `{{name}}` placeholders of a string, as a set (a translation may repeat one). */
export function placeholderSet(text: string): Set<string> {
	return new Set(Array.from(text.matchAll(PLACEHOLDER_PATTERN), match => match[1] ?? ""))
}

/** The react-i18next markup tags of a string (`<link>`, `</link>`, `<br/>`), as a set. */
export function markupSet(text: string): Set<string> {
	return new Set(Array.from(text.matchAll(MARKUP_PATTERN), match => `<${match[1] ?? ""}${match[2] ?? ""}${match[3] ?? ""}>`))
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every(value => b.has(value))
}

/**
 * What is wrong with a translated catalog against its English source, one line per problem: keys English does not
 * have, placeholder or markup sets that differ from English (`_few` / `_many` compare against `_other`; a `_one` form
 * may leave out `{{count}}`), and plural groups missing a category an integer count selects in that language or
 * holding one it cannot. Empty when the catalog is clean.
 */
export function catalogIssues(english: Catalog, target: Catalog, lang: string): string[] {
	const issues: string[] = []
	const pluralBases = computePluralBases(english)
	const reachable = new Set(cldrCategories(lang))
	const targetGroups = new Map<string, Set<string>>()

	for (const [key, value] of Object.entries(target)) {
		const split = splitPluralKey(key)
		const group = split !== null && pluralBases.has(split.base) ? split : null
		const source = english[key] ?? (group === null ? undefined : english[`${group.base}_other`])

		if (source === undefined) {
			issues.push(`${key}: not in English`)

			continue
		}

		if (group !== null) {
			const categories = targetGroups.get(group.base) ?? new Set<string>()

			categories.add(group.category)
			targetGroups.set(group.base, categories)
		}

		const expected = placeholderSet(source)
		const actual = placeholderSet(value)

		if (group?.category === "one") {
			expected.delete("count")
			actual.delete("count")
		}

		if (!sameSet(expected, actual)) {
			issues.push(`${key}: placeholders ${[...actual].join(",")} differ from English ${[...expected].join(",")}`)
		}

		if (!sameSet(markupSet(source), markupSet(value))) {
			issues.push(`${key}: markup differs from English`)
		}
	}

	for (const [base, categories] of targetGroups) {
		const allowed = new Set([...(pluralBases.get(base) ?? []), ...reachable])

		for (const category of reachable) {
			if (!categories.has(category)) {
				issues.push(`${base}: missing plural form _${category}`)
			}
		}

		for (const category of categories) {
			if (!allowed.has(category)) {
				issues.push(`${base}: plural form _${category} is never selected in ${lang}`)
			}
		}
	}

	return issues
}

/** The `english` keys a target catalog lacks. */
export function missingKeys(english: Catalog, target: Catalog): string[] {
	return Object.keys(english).filter(key => !(key in target))
}
