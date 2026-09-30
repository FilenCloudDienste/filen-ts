/**
 * The dependency-free core of the apps' translate-i18n scripts: CLI parsing, CLDR plural expansion,
 * the translator system prompt, the structured-output schema and batching. Each script keeps its own
 * catalog shape, model, target languages and Anthropic call. Node-only build tooling, reachable solely
 * through the "@filen/shared/tooling/i18n" subpath so it never enters an app bundle.
 */

export type CliArgs<L extends string> = {
	full: boolean
	languages: readonly L[]
}

/** `--full` plus a bare or comma-separated language list, e.g. `de` or `de,fr,ja`. No list means every language. */
export function parseCliArgs<L extends string>(argv: readonly string[], allowed: readonly L[]): CliArgs<L> {
	let full = false
	const requested: L[] = []

	for (const arg of argv) {
		if (arg === "--full") {
			full = true

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
		languages: requested.length > 0 ? requested : allowed
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
 * The stable, cached system prefix: instructions plus the full JSDoc-rich English source. `product`
 * names the app the strings belong to ("mobile" / "web").
 */
export function buildSystemPrompt(englishSource: string, product: string): string {
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
		"The full English source catalog follows, WITH its JSDoc comments, so you can see exactly where",
		"and how each key is used. Use it as context; only translate the keys requested in each message.",
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
 * Translates a subset batch by batch through the caller's model call and merges the results. Throws if
 * the model omits any requested key, so a truncated batch never writes an incomplete catalog. `label`
 * prefixes the log lines and errors (e.g. "de" or "de/common").
 */
export async function translateSubset({
	label,
	subset,
	translateBatch
}: {
	label: string
	subset: Record<string, string>
	translateBatch: (batch: Record<string, string>) => Promise<Record<string, string>>
}): Promise<Record<string, string>> {
	const batches = chunkEntries(subset, BATCH_SIZE)
	const result: Record<string, string> = {}

	for (let index = 0; index < batches.length; index++) {
		const batch = batches[index]

		if (batch === undefined) {
			continue
		}

		console.log(`[translate-i18n] ${label}: batch ${index + 1}/${batches.length} (${Object.keys(batch).length} keys)`)

		Object.assign(result, await translateBatch(batch))
	}

	for (const key of Object.keys(subset)) {
		if (!(key in result)) {
			throw new Error(`${label}: model did not return a translation for key "${key}"`)
		}
	}

	return result
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
