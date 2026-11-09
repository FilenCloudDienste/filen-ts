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
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
	applyRemovals,
	buildSystemPrompt,
	computeDelta,
	coversEveryLanguage,
	englishSource as toEnglishSource,
	keysToTranslate,
	LANGUAGE_NAMES,
	parseCliArgs,
	readJsonObject,
	sortRecord,
	translateBatch,
	translateDryRun,
	translateSubset,
	writeJsonFile,
	type Catalog,
	type CreateMessage
} from "@filen/shared/tooling/i18n"

import { en } from "@/locales/en"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"

// NOTE: do NOT import from `@/lib/language` here — it transitively pulls in React Native
// (via secureStore), which a Node/tsx run cannot evaluate. `@/locales/languages` is import-free
// by contract (its own comment), so it's the only locale module safe to import in this script.
// The delta, plural, removal and model-call logic is shared with the web script
// (@filen/shared/tooling/i18n); this file keeps the flat catalog files and the prompt context.

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const MODEL = "claude-opus-5-5"
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

// English catalog as a flat key→value map. The barrel merges the area files into one `as const`
// object; every value is a string (plural keys are separate `_one`/`_other` entries).
const EN_CATALOG: Catalog = en
const EN_SOURCE = toEnglishSource(EN_CATALOG)

const DRY_RUN = process.env["DRY_RUN"] === "1"

// ---------------------------------------------------------------------------
// English source files as translator context (JSDoc-rich)
// ---------------------------------------------------------------------------

// Concatenate the raw `src/locales/en/*.ts` files as text. Their JSDoc comments describe what
// each key means and where it's used — invaluable context for the translator, and a stable
// prefix that prompt caching reuses across every language.
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

// A flat catalog file (the snapshot or a target). Null when absent or blank; throws on a non-object.
function readCatalog(path: string, label: string): Catalog | null {
	return readJsonObject(path, label) as Catalog | null
}

// Sorted keys + trailing newline for stable diffs.
function writeSortedJson(path: string, record: Catalog): void {
	writeJsonFile(path, sortRecord(record))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2), TARGET_LANGUAGES)
	const delta = args.full
		? { upsert: {}, removed: [] }
		: computeDelta(readCatalog(EN_SNAPSHOT_PATH, ".en-snapshot.json"), EN_CATALOG)
	const system = [buildSystemPrompt(readEnglishSourceFiles(), "mobile")]

	console.log(`[translate-i18n] mode=${args.full ? "FULL" : "DELTA"} dryRun=${DRY_RUN}`)
	console.log(`[translate-i18n] english catalog: ${Object.keys(EN_CATALOG).length} keys`)
	console.log(`[translate-i18n] target languages: ${args.languages.join(", ")}`)

	if (!args.full) {
		console.log(
			`[translate-i18n] delta: ${Object.keys(delta.upsert).length} added/changed, ${delta.removed.length} removed`
		)
	}

	let createMessage: CreateMessage | null = null

	if (!DRY_RUN) {
		const apiKey = process.env["ANTHROPIC_API_KEY"]

		if (apiKey === undefined || apiKey.length === 0) {
			throw new Error("ANTHROPIC_API_KEY is not set (and DRY_RUN is not enabled)")
		}

		// The SDK reads ANTHROPIC_API_KEY from the environment itself; constructing without
		// passing the value keeps it out of any logged constructor args.
		const client = new Anthropic()

		createMessage = request => client.beta.messages.create(request)
	}

	for (const lang of args.languages) {
		const catalogPath = join(LOCALES_DIR, `${lang}.json`)
		const existing = readCatalog(catalogPath, `Catalog ${lang}.json`) ?? {}
		const subset = keysToTranslate({ source: EN_SOURCE, full: args.full, delta, existing, lang })
		const merged: Catalog = {
			...existing
		}

		applyRemovals(merged, delta.removed)

		const subsetKeyCount = Object.keys(subset).length

		if (subsetKeyCount > 0) {
			console.log(`[translate-i18n] ${lang}: translating ${subsetKeyCount} keys`)

			const send = createMessage
			const translated =
				send === null
					? translateDryRun(lang, subset)
					: await translateSubset({
							label: lang,
							subset,
							translateBatch: batch =>
								translateBatch({
									createMessage: send,
									model: MODEL,
									system,
									lang,
									languageName: LANGUAGE_NAMES[lang],
									batch
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
	// snapshot in place, so a re-run re-detects the same delta and retries — and only when the run
	// covered every language, or the ones left out would never see the changed keys. Written into
	// the same PR as the translations, so the baseline only advances once that PR is merged.
	if (coversEveryLanguage(args.languages, TARGET_LANGUAGES)) {
		writeSortedJson(EN_SNAPSHOT_PATH, EN_CATALOG)
	} else {
		console.log("[translate-i18n] snapshot not advanced: the run covered only some languages")
	}

	console.log("[translate-i18n] done")
}

main().catch(error => {
	// Surface a clean message; never echo the API key.
	console.error("[translate-i18n] failed:", error instanceof Error ? error.message : String(error))
	process.exit(1)
})
