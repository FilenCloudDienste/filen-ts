# i18n translation pipeline

`translate-i18n.ts` fills the target-language catalogs (`src/locales/<lang>.json`, one per non-English entry of
`SUPPORTED_LANGUAGES` in `@filen/shared/languages`) from the English source catalogs (`src/locales/en/**/*.ts`) using
the Anthropic Messages API (model: `MODEL` in the script). The other scripts in this directory are self-documented.

English is the single source of truth and ships in the app bundle. Every other language is machine-translated and
**always needs human review** before it ships.

## How it works

```
src/locales/en/<namespace>.ts (+ the sub-files it spreads) ──▶ namespace → key → English string
        │                                                                │
        │ (raw file text, JSDoc-rich, + common.ts, as context)           │ (delta or full subset)
        ▼                                                                ▼
   cached system prompt per unit ─────────▶ Anthropic Messages API ─────▶ { key: translated }
   (one namespace; preview: one sub-file)       every language in turn             │
                                                                                    ▼
                                                        merged into src/locales/<lang>.json, nested by namespace
                                                        (sorted keys, trailing newline), written after each namespace
```

- **Units.** A namespace is translated with its own files (the namespace file and the sub-catalogs it spreads, plus
  `common.ts` for shared terms) as context, never the whole catalog. `preview` spreads dozens of editor sub-catalogs,
  so each of its sub-files is a unit of its own (`SPLIT_BY_FILE`). Text spread from `@filen/shared` (the desktop
  shell's strings) is listed in `EXTERNAL_SOURCES`.
- **Prompt cache.** The loop is unit-outer, language-inner: every language of a unit sends the same cached system
  prompt, so one cache write serves all 27.
- **Checkpoints.** After each namespace every requested catalog and the manifest are written, so a failure keeps what
  was already paid for. All requested catalogs are held in memory (about 0.5 MB each).
- The delta, plural expansion, removals and the request itself are shared with filen-mobile's script
  (`@filen/shared/tooling/i18n`).

## Files

| File | Written by | Read by |
| --- | --- | --- |
| `src/locales/<lang>.json` | every run | the app, fetched only for the active language (a static asset, not code) |
| `src/locales/.en-snapshot.json` | a run that covered every language, or `--snapshot-only` | the next DELTA run |
| `src/locales/.catalogs.json` | every run, `--snapshot-only` | the app: how many English keys each catalog holds |

The app offers a language only when its catalog holds at least 95% of the English keys, so a partial run never shows
a half-English UI. The dotfiles are never served (the app's catalog URL pattern skips them).

## Modes

| Command | Mode | What it translates |
| --- | --- | --- |
| `pnpm run translate-i18n` | **DELTA** (default) | Keys added/changed since the snapshot, plus any English key missing from a target catalog. Removed keys are deleted from every catalog. |
| `pnpm run translate-i18n --full` | **FULL** | Every English key for every target language. |
| `pnpm run translate-i18n de,fr` | (either) | Only these languages. The snapshot is left alone, so the others still see the changed keys next time. |
| `pnpm run translate-i18n --snapshot-only` | — | Writes the snapshot and the manifest; translates nothing. |

Until a language's catalog exists, a DELTA run translates that whole language: the missing-key safety net fills every
absent key. **The first run of any kind is therefore the full paid run.**

### `DRY_RUN=1` — preview with zero token spend

```bash
DRY_RUN=1 pnpm run translate-i18n --full
```

Skips the API and stubs each translation as `"<lang>:<english>"`. **Delete the stub output afterwards**
(`src/locales/<lang>.json`, and restore `.en-snapshot.json` and `.catalogs.json` from git), or the app offers the stub
languages.

## Rolling out the languages

1. Done: the shared pipeline, the seeded `.en-snapshot.json` and an empty manifest.
2. The full run (approve the API cost first). About 6,500 keys × 27 languages at 25 keys per request is
   roughly 7,000 sequential requests, well past GitHub's 6-hour job limit, so run it locally
   (`ANTHROPIC_API_KEY=… pnpm run translate-i18n --full`, resumable: a re-run only fills what is missing) and commit
   the catalogs, the snapshot and the manifest together.
3. After that has merged: enable the push trigger in `.github/workflows/i18n-web.yml` (see its header).

The workflow is dispatch-only until then (GitHub → Actions → **i18n translate (web)** → *Run workflow*). It opens or
updates the rolling PR `i18n: update web translations`. The PR is opened by the workflow's `GITHUB_TOKEN`, so it does
not trigger downstream CI; merging it by hand runs the full CI on `main`.

## Adding a language

1. `@filen/shared/languages` — add it to `SUPPORTED_LANGUAGES` and `LANGUAGE_LABELS` (mobile's literal copy in
   `filen-mobile/src/locales/languages.ts` must follow, with a native release).
2. `@filen/shared/tooling/i18n` — add its English name to `LANGUAGE_NAMES`.
3. Run the pipeline for it. The app offers it once its catalog is near-complete.

The key is read from `process.env.ANTHROPIC_API_KEY` — never hardcoded, never logged.
