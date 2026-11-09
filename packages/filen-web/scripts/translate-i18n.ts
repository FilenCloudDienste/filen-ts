// i18n translation pipeline — fills the target-language catalogs (src/locales/<lang>.json)
// from the English source catalogs (src/locales/en/**/*.ts) via the Anthropic Messages API.
// scripts/README.md describes the modes, the files it writes and the order of the first run.
//
// The English source is split across real i18next namespaces — the list lives in
// `@/lib/i18n/catalog` (EN_NAMESPACES), and each namespace file exports its own `as const` object.
// Every target-language catalog nests translations under the same namespace keys, e.g.
// `{ "common": {...}, "errors": {...} }`.
//
// Run with: pnpm run translate-i18n                     (DELTA mode — only changed English keys)
//           pnpm run translate-i18n --full              (FULL mode — every key for every language, resumable)
//           pnpm run translate-i18n de,fr               (restrict to specific languages)
//           pnpm run translate-i18n --budget-minutes=300 (stop at the next batch boundary after 300 minutes, exit 3)
//           pnpm run translate-i18n --snapshot-only     (write the snapshot and manifest, translate nothing)
//           No `--` separator: pnpm forwards it to the script as a literal argument.
//
// DRY_RUN=1 — skip the Anthropic API entirely; stub each translation as "<lang>:<english>".
//
// Reads ANTHROPIC_API_KEY from the environment — never hardcoded, never logged.

import Anthropic from "@anthropic-ai/sdk"
import { readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import {
	applyRemovals,
	BUDGET_EXHAUSTED_EXIT_CODE,
	buildSystemPrompt,
	computeDelta,
	coveredKeyCount,
	coversEveryLanguage,
	deadlineAfter,
	englishSource,
	keysToTranslate,
	LANGUAGE_NAMES,
	parseCliArgs,
	readJsonObject,
	recordSources,
	sortRecord,
	SOURCES_DIR_NAME,
	staleKeys,
	translateBatch,
	translateDryRun,
	translateSubset,
	writeJsonFile,
	type Catalog,
	type CreateMessage,
	type Delta
} from "@filen/shared/tooling/i18n"
import { SUPPORTED_LANGUAGES, type TargetLanguage } from "@filen/shared/languages"
import { EN_NAMESPACES, EN_CATALOGS, type EnNamespace } from "@/lib/i18n/catalog"

// NOTE: do NOT import from `@/lib/i18n` here — its index module initialises i18next as an import-time
// side effect. `@/lib/i18n/catalog` is side-effect free and owns the namespace list both the app and
// this pipeline read, so a namespace added there is translated without touching this file.

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const MODEL = "claude-opus-5-5"
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(SCRIPT_DIR, "..")
const EN_SOURCE_DIR = join(PACKAGE_DIR, "src", "locales", "en")
const LOCALES_DIR = join(PACKAGE_DIR, "src", "locales")
// Baseline for the DELTA diff: the English catalog as of the last translation (namespace -> key ->
// value). A dotfile, so the runtime's catalog glob never serves it.
const EN_SNAPSHOT_PATH = join(LOCALES_DIR, ".en-snapshot.json")
// How many English keys each catalog holds; the runtime offers a language only when it is nearly complete.
const MANIFEST_PATH = join(LOCALES_DIR, ".catalogs.json")
// Per language, the English each key was translated from (namespace -> key -> hash): what a FULL re-run skips.
const SOURCES_DIR = join(LOCALES_DIR, SOURCES_DIR_NAME)

// Every supported language but English, the source.
const TARGET_LANGUAGES: readonly TargetLanguage[] = SUPPORTED_LANGUAGES.filter((lang): lang is TargetLanguage => lang !== "en")

// Namespaces whose keys are translated one sub-file at a time, each with only its own file as context: preview
// spreads ~60 editor sub-catalogs, together far larger than any one request needs.
const SPLIT_BY_FILE: ReadonlySet<EnNamespace> = new Set(["preview"])

// English text a namespace spreads from outside src/locales/en, keyed by its import specifier.
const EXTERNAL_SOURCES: Readonly<Record<string, string>> = {
	"@filen/shared/desktopShellStrings": fileURLToPath(import.meta.resolve("@filen/shared/desktopShellStrings"))
}

const NAMESPACES = EN_NAMESPACES

type Namespace = EnNamespace

type NestedCatalog = Record<Namespace, Catalog>

const EN_CATALOG: NestedCatalog = EN_CATALOGS

// Object.fromEntries erases the key union; NAMESPACES lists every key of the catalog object, so every key is present.
function perNamespace<T>(make: (ns: Namespace) => T): Record<Namespace, T> {
	return Object.fromEntries(NAMESPACES.map(ns => [ns, make(ns)])) as Record<Namespace, T>
}

const DRY_RUN = process.env["DRY_RUN"] === "1"

// ---------------------------------------------------------------------------
// Translation units: which keys share one prompt context
// ---------------------------------------------------------------------------

interface Unit {
	ns: Namespace
	label: string
	// Source files sent as context, besides common.ts.
	files: readonly string[]
	keys: readonly string[]
}

const IMPORT_PATTERN = /^import\s+\{([^}]*)\}\s+from\s+"([^"]+)"/gm

// The English files a namespace file spreads in, with the export names it imports from each.
function spreadSources(file: string): { path: string; names: string[] }[] {
	const sources: { path: string; names: string[] }[] = []

	for (const match of readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)) {
		const specifier = match[2] ?? ""
		const names = (match[1] ?? "")
			.split(",")
			.map(name => name.trim())
			.filter(name => name.length > 0 && !name.startsWith("type "))
		const path = specifier.startsWith("@/locales/en/")
			? join(EN_SOURCE_DIR, `${specifier.slice("@/locales/en/".length)}.ts`)
			: EXTERNAL_SOURCES[specifier]

		if (path !== undefined && names.length > 0) {
			sources.push({ path, names })
		}
	}

	return sources
}

async function unitsOf(ns: Namespace): Promise<Unit[]> {
	const namespaceFile = join(EN_SOURCE_DIR, `${ns}.ts`)
	const sources = spreadSources(namespaceFile)
	const allKeys = Object.keys(EN_CATALOG[ns])

	if (!SPLIT_BY_FILE.has(ns)) {
		return [{ ns, label: ns, files: [namespaceFile, ...sources.map(source => source.path)], keys: allKeys }]
	}

	const owned = new Set<string>()
	const units: Unit[] = []

	for (const source of sources) {
		const module = (await import(source.path)) as Record<string, unknown>
		const keys: string[] = []

		for (const name of source.names) {
			const value = module[name]

			if (typeof value === "object" && value !== null) {
				keys.push(...Object.keys(value))
			}
		}

		for (const key of keys) {
			owned.add(key)
		}

		units.push({ ns, label: `${ns}/${relative(EN_SOURCE_DIR, source.path)}`, files: [source.path], keys })
	}

	const own = allKeys.filter(key => !owned.has(key))

	if (own.length > 0) {
		units.unshift({ ns, label: ns, files: [namespaceFile], keys: own })
	}

	return units
}

// The JSDoc-rich English files of a unit plus common.ts, whose shared terms every namespace reuses.
function unitContext(unit: Unit): string {
	const commonFile = join(EN_SOURCE_DIR, "common.ts")
	const files = unit.files.includes(commonFile) ? unit.files : [commonFile, ...unit.files]

	return files.map(file => `// ===== ${relative(PACKAGE_DIR, file)} =====\n${readFileSync(file, "utf8")}`).join("\n\n")
}

function pick(record: Catalog, keys: readonly string[]): Catalog {
	const out: Catalog = {}

	for (const key of keys) {
		const value = record[key]

		if (value !== undefined) {
			out[key] = value
		}
	}

	return out
}

// ---------------------------------------------------------------------------
// Catalog files
// ---------------------------------------------------------------------------

// One namespace's slice of a nested catalog file: absent → empty (a namespace added after the file was written),
// anything but a plain object → throw.
function namespaceRecord(record: Record<string, unknown>, ns: Namespace, label: string): Catalog {
	const value = record[ns]

	if (value === undefined) {
		return {}
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} namespace "${ns}" is not a JSON object`)
	}

	return value as Catalog
}

function readNested(path: string, label: string): NestedCatalog | null {
	const record = readJsonObject(path, label)

	return record === null ? null : perNamespace(ns => namespaceRecord(record, ns, label))
}

function writeNested(path: string, catalog: NestedCatalog): void {
	writeJsonFile(
		path,
		perNamespace(ns => sortRecord(catalog[ns]))
	)
}

function languagePath(lang: TargetLanguage): string {
	return join(LOCALES_DIR, `${lang}.json`)
}

function sourcesPath(lang: TargetLanguage): string {
	return join(SOURCES_DIR, `${lang}.json`)
}

// How many current English keys each catalog on disk holds.
function writeManifest(catalogs: ReadonlyMap<TargetLanguage, NestedCatalog>): void {
	const languages: Partial<Record<TargetLanguage, number>> = {}

	for (const lang of TARGET_LANGUAGES) {
		const catalog = catalogs.get(lang) ?? readNested(languagePath(lang), `Catalog ${lang}.json`)

		if (catalog !== null) {
			languages[lang] = NAMESPACES.reduce((sum, ns) => sum + coveredKeyCount(EN_CATALOG[ns], catalog[ns]), 0)
		}
	}

	writeJsonFile(MANIFEST_PATH, { languages })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function countKeys(catalog: NestedCatalog): number {
	return NAMESPACES.reduce((sum, ns) => sum + Object.keys(catalog[ns]).length, 0)
}

// The process exit code: 0 when done, BUDGET_EXHAUSTED_EXIT_CODE when the time budget stopped the run.
async function main(): Promise<number> {
	const argv = process.argv.slice(2)
	const snapshotOnly = argv.includes("--snapshot-only")
	const args = parseCliArgs(
		argv.filter(arg => arg !== "--snapshot-only"),
		TARGET_LANGUAGES
	)

	if (snapshotOnly) {
		writeNested(EN_SNAPSHOT_PATH, EN_CATALOG)
		writeManifest(new Map())
		console.log("[translate-i18n] wrote the snapshot and the manifest; nothing translated")

		return 0
	}

	const snapshot = args.full ? null : readNested(EN_SNAPSHOT_PATH, ".en-snapshot.json")
	const delta: Record<Namespace, Delta> = perNamespace(ns =>
		args.full ? { upsert: {}, removed: [] } : computeDelta(snapshot?.[ns] ?? null, EN_CATALOG[ns])
	)

	console.log(`[translate-i18n] mode=${args.full ? "FULL" : "DELTA"} dryRun=${String(DRY_RUN)}`)
	console.log(`[translate-i18n] english catalog: ${String(countKeys(EN_CATALOG))} keys across ${String(NAMESPACES.length)} namespaces`)
	console.log(`[translate-i18n] target languages: ${args.languages.join(", ")}`)

	if (!args.full) {
		const upsertCount = NAMESPACES.reduce((sum, ns) => sum + Object.keys(delta[ns].upsert).length, 0)
		const removedCount = NAMESPACES.reduce((sum, ns) => sum + delta[ns].removed.length, 0)

		console.log(`[translate-i18n] delta: ${String(upsertCount)} added/changed, ${String(removedCount)} removed`)
	}

	// Created on the first request, so a run with nothing left to translate (a finished language, a zero budget) needs
	// no key.
	let client: Anthropic | null = null
	const createMessage: CreateMessage | null = DRY_RUN
		? null
		: request => {
				if (client === null) {
					const apiKey = process.env["ANTHROPIC_API_KEY"]

					if (apiKey === undefined || apiKey.length === 0) {
						throw new Error("ANTHROPIC_API_KEY is not set (and DRY_RUN is not enabled)")
					}

					// The SDK reads ANTHROPIC_API_KEY from the environment itself; constructing without
					// passing the value keeps it out of any logged constructor args.
					client = new Anthropic()
				}

				return client.beta.messages.create(request)
			}
	const shouldStop = deadlineAfter(args.budgetMinutes)

	// Every requested language held in memory (about 0.5 MB each, twice that with its resume record), so each unit can
	// be written as a checkpoint.
	const catalogs = new Map<TargetLanguage, NestedCatalog>()
	// FULL keeps a resume record for every language; DELTA updates the records a stopped FULL run left behind.
	const records = new Map<TargetLanguage, NestedCatalog>()

	for (const lang of args.languages) {
		const existing = readNested(languagePath(lang), `Catalog ${lang}.json`)
		const record = readNested(sourcesPath(lang), `Resume record ${lang}.json`)

		catalogs.set(
			lang,
			perNamespace(ns => ({ ...(existing?.[ns] ?? {}) }))
		)

		if (record !== null || args.full) {
			records.set(
				lang,
				perNamespace(ns => ({ ...(record?.[ns] ?? {}) }))
			)
		}
	}

	// Languages changed since their last checkpoint; all of them at first, so every requested catalog is written (sorted,
	// with every namespace) even when nothing in it changes.
	const dirty = new Set<TargetLanguage>(catalogs.keys())

	const checkpoint = (): void => {
		for (const lang of dirty) {
			const catalog = catalogs.get(lang)
			const record = records.get(lang)

			if (catalog !== undefined) {
				writeNested(languagePath(lang), catalog)
			}

			if (record !== undefined) {
				writeNested(sourcesPath(lang), record)
			}
		}

		dirty.clear()
	}

	let complete = true

	// Namespace outer, language inner: every language of a unit sends the same cached system prompt, so one cache
	// write serves all of them. A checkpoint after every unit; a failure also writes the batches it already got.
	try {
		translation: for (const ns of NAMESPACES) {
			// DELTA removes what left English since the snapshot; FULL whatever English no longer has.
			const namespaceSource = args.full ? englishSource(EN_CATALOG[ns]) : null

			for (const [lang, catalog] of catalogs) {
				const record = records.get(lang)?.[ns]
				const removed = namespaceSource === null ? delta[ns].removed : staleKeys(namespaceSource, catalog[ns])

				applyRemovals(catalog[ns], removed)

				if (record !== undefined) {
					applyRemovals(record, namespaceSource === null ? removed : staleKeys(namespaceSource, record))
				}

				if (removed.length > 0) {
					dirty.add(lang)
				}
			}

			for (const unit of await unitsOf(ns)) {
				const source = englishSource(pick(EN_CATALOG[ns], unit.keys))
				const unitDelta: Delta = { upsert: pick(delta[ns].upsert, unit.keys), removed: [] }
				const system = [buildSystemPrompt(unitContext(unit), "web", true)]

				for (const [lang, catalog] of catalogs) {
					const record = records.get(lang)?.[ns]
					const subset = keysToTranslate({
						source,
						full: args.full,
						delta: unitDelta,
						existing: catalog[ns],
						lang,
						sources: args.full ? (record ?? null) : null
					})
					const subsetKeyCount = Object.keys(subset).length

					if (subsetKeyCount === 0) {
						continue
					}

					console.log(`[translate-i18n] ${lang}/${unit.label}: translating ${String(subsetKeyCount)} keys`)

					const send = createMessage
					const finished = await translateSubset({
						label: `${lang}/${unit.label}`,
						subset,
						translateBatch:
							send === null
								? batch => Promise.resolve(translateDryRun(lang, batch))
								: batch =>
										translateBatch({
											createMessage: send,
											model: MODEL,
											system,
											lang,
											languageName: LANGUAGE_NAMES[lang],
											batch
										}),
						onBatch: translated => {
							Object.assign(catalog[ns], translated)

							if (record !== undefined) {
								recordSources(record, translated, subset)
							}

							dirty.add(lang)
						},
						shouldStop
					})

					if (!finished) {
						complete = false

						break translation
					}
				}

				checkpoint()
			}

			writeManifest(catalogs)
			console.log(`[translate-i18n] ${ns}: written for ${String(catalogs.size)} languages`)
		}
	} finally {
		checkpoint()
	}

	if (!complete) {
		writeManifest(catalogs)
		console.log(
			"[translate-i18n] time budget used up: stopped after a checkpoint. Run the same command again to continue; the snapshot was not advanced."
		)

		return BUDGET_EXHAUSTED_EXIT_CODE
	}

	for (const [lang, catalog] of catalogs) {
		console.log(`[translate-i18n] ${lang}: ${String(countKeys(catalog))} keys`)
	}

	// Advance the baseline only after every namespace succeeded, and only when the run covered every language, or the
	// ones left out would never see the changed keys again. Written into the same PR as the translations, so the
	// baseline only advances once that PR is merged. The resume records go with it: every language is complete, so the
	// next FULL run starts over.
	if (coversEveryLanguage(args.languages, TARGET_LANGUAGES)) {
		writeNested(EN_SNAPSHOT_PATH, EN_CATALOG)
		rmSync(SOURCES_DIR, { recursive: true, force: true })
	} else {
		console.log("[translate-i18n] snapshot not advanced: the run covered only some languages")
	}

	console.log("[translate-i18n] done")

	return 0
}

main().then(
	code => {
		process.exitCode = code
	},
	(error: unknown) => {
		// Surface a clean message; never echo the API key.
		console.error("[translate-i18n] failed:", error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
)
