# i18n translation pipeline

`translate-i18n.ts` fills the eight target-language catalogs
(`src/locales/<lang>.json`) from the English source catalog
(`src/locales/en/*.ts`) using the Anthropic Messages API (`claude-opus-4-8`).

English is the single source of truth. Every other language is machine-translated
and **always needs human review** before it ships.

## How it works

```
src/locales/en/*.ts ──(merged barrel: src/locales/en)──▶ key → English string
        │                                                        │
        │ (raw file text, JSDoc-rich, as translator context)     │ (delta or full subset)
        ▼                                                        ▼
   cached system prompt  ──────────────▶  Anthropic Messages API  ──────────────▶  { key: translated }
   (instructions + glossary + full                 per language                            │
    English source, reused across all 8)                                                   ▼
                                                                          merge into src/locales/<lang>.json
                                                                          (sorted keys + trailing newline)
```

- The **stable system prefix** (translator instructions, do-not-translate glossary, and the
  full English source files) is sent with `cache_control: { type: "ephemeral" }`, so the first
  language writes the prompt cache and the remaining seven read it.
- The **varying part** (the subset of keys to translate + the target language name) is the
  per-language user message.
- Output is forced to a flat `{ key: translated }` map via
  `output_config.format` (`json_schema`, `additionalProperties: string`).
- Results merge into the existing catalog: added/changed keys are applied, removed keys are
  deleted, untouched translations are preserved. Catalogs are written with **sorted keys** and a
  **trailing newline** for stable diffs.

The glossary keeps the brand (`Filen` / `Filen.io`) untranslated, preserves `{{variables}}`
exactly, preserves react-i18next `<link>…</link>` markup, and treats plural `_one`/`_other`
keys as separate entries.

## Modes

| Command | Mode | What it translates |
| --- | --- | --- |
| `npm run translate-i18n` | **DELTA** (default) | Keys added/changed in `src/locales/en` since the previous commit (`git diff HEAD~1`), plus any English key missing from a target catalog (covers fresh/empty stubs). Removed keys are deleted from every catalog. |
| `npm run translate-i18n -- --full` | **FULL** | Every English key for every target language. |
| `npm run translate-i18n -- de,fr` | (either) | Restrict to specific languages (comma-separated or repeated args). |

### `DRY_RUN=1` — preview with zero token spend

```bash
DRY_RUN=1 npm run translate-i18n -- --full
```

Skips the Anthropic API entirely and stubs each translation as `"<lang>:<english>"`
(e.g. `"de:Cancel"`). Use it to exercise the catalog-read / delta / file-write logic without
spending tokens. **Revert the stub output afterwards** (`git checkout src/locales/*.json`) so you
don't commit dry-run placeholders.

## One-time setup

Add an `ANTHROPIC_API_KEY` repository secret
(GitHub → Settings → Secrets and variables → Actions → New repository secret).
The key is read from `process.env.ANTHROPIC_API_KEY` — never hardcoded, never logged.

## Running the initial FULL translation

The catalogs ship as empty `{}` stubs. To populate all eight languages the first time:

- **Via CI (recommended):** GitHub → Actions → **i18n translate** → *Run workflow* →
  set `mode = full`. It opens a PR (`i18n: update translations`) for review.
- **Locally:** `DRY_RUN=1 npm run translate-i18n -- --full` to preview the file structure, then
  `ANTHROPIC_API_KEY=… npm run translate-i18n -- --full` to actually translate.

After the first full run, the workflow runs automatically (DELTA mode) on every push to `main`
that changes `packages/filen-mobile/src/locales/en/**`.

> The PR is opened by the workflow's `GITHUB_TOKEN`, so it does **not** trigger downstream CI
> (lint / typecheck / tests). Merging it by hand runs the full CI on `main`.

## Adding a new language later

A language only becomes selectable in the app once its catalog has at least one key
(`hasTranslations()` in `src/lib/i18n.ts` gates the picker), so the wiring and the translations
can land independently. To add one (example: Korean `ko`):

1. `src/locales/languages.ts` — add `"ko"` to `SUPPORTED_LANGUAGES`.
2. `src/lib/language.ts` — add a native `LANGUAGE_LABELS` entry (e.g. `ko: "한국어"`).
3. `src/lib/i18n.ts` — `import koJson from "@/locales/ko.json"` and add
   `ko: { translation: koJson }` to `resources`.
4. `scripts/translate-i18n.ts` — add the English name to `LANGUAGE_NAMES` (e.g. `ko: "Korean"`)
   — typed `Record<TargetLanguage, string>`, so this is a compile error until you do.
5. Create the empty stub: `echo '{}' > src/locales/ko.json`.
6. Run the pipeline (`--full`, or restrict to `ko`) to populate it.
