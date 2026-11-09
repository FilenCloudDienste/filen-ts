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
                                                        (sorted keys, trailing newline), written after each unit
```

- **Units.** A namespace is translated with its own files (the namespace file and the sub-catalogs it spreads, plus
  `common.ts` for shared terms) as context, never the whole catalog. `preview` spreads dozens of editor sub-catalogs,
  so each of its sub-files is a unit of its own (`SPLIT_BY_FILE`). Text spread from `@filen/shared` (the desktop
  shell's strings) is listed in `EXTERNAL_SOURCES`.
- **Prompt cache.** The loop is unit-outer, language-inner: every language of a unit sends the same cached system
  prompt, so one cache write serves all 27.
- **Checkpoints.** After each unit the changed catalogs (and resume records) are written, after each namespace the
  manifest too. A failure or a time-budget stop first writes every batch already translated, so it keeps what was
  paid for. Files are replaced atomically (temporary file + rename), so a killed run never leaves a truncated catalog.
  All requested catalogs are held in memory (about 0.5 MB each, as much again for their resume records).
- **Retries.** A batch that fails transiently (HTTP 408/409/429/5xx including the 529 overload, a connection error) is
  retried with backoff (5 s, 15 s, 45 s; 4 attempts). A reply that is unusable (a missing key, `{{placeholders}}` or
  markup that differ from English, an early stop, unreadable JSON) is retried once. Anything else, or a batch past its
  attempts, ends the run with exit code 1 after the checkpoint.
- The delta, plural expansion, removals and the request itself are shared with filen-mobile's script
  (`@filen/shared/tooling/i18n`).

## Files

| File | Written by | Read by |
| --- | --- | --- |
| `src/locales/<lang>.json` | every run | the app, fetched only for the active language (a static asset, not code) |
| `src/locales/.en-snapshot.json` | a run that covered every language, or `--snapshot-only` | the next DELTA run |
| `src/locales/.catalogs.json` | every run, `--snapshot-only` | the app: how many English keys each catalog holds |
| `src/locales/.sources/<lang>.json` | FULL runs (DELTA updates one that exists) | the next FULL run: what it may skip; deleted by a run that completes every language |

The app offers a language only when its catalog holds at least 95% of the English keys, so a partial run never shows
a half-English UI. The dotfiles are never served (the app's catalog URL pattern skips them).

## Modes

| Command | Mode | What it translates |
| --- | --- | --- |
| `pnpm run translate-i18n` | **DELTA** (default) | Keys added/changed since the snapshot, plus any English key missing from a target catalog. Removed keys are deleted from every catalog. |
| `pnpm run translate-i18n --full` | **FULL** | Every English key for every target language, except what an earlier FULL run of this campaign already translated (see *Resuming FULL*). Keys English no longer has are deleted. |
| `pnpm run translate-i18n de,fr` | (either) | Only these languages. The snapshot is left alone, so the others still see the changed keys next time. |
| `pnpm run translate-i18n --budget-minutes=300` | (either) | Stops at the next batch boundary once 300 minutes (decimals allowed) have passed, writes the checkpoint and exits with code **3**. `0` translates nothing: exit 0 means nothing was left to do. |
| `pnpm run translate-i18n --snapshot-only` | — | Writes the snapshot and the manifest; translates nothing. |

Until a language's catalog exists, a DELTA run translates that whole language: the missing-key safety net fills every
absent key. **The first run of any kind is therefore the full paid run.**

### Resuming FULL

A FULL run records, per language, a hash of the English each key was translated from
(`src/locales/.sources/<lang>.json`, namespace → key → hash, written with every checkpoint). A FULL re-run skips a key
when the target catalog holds it **and** its recorded hash matches the current English; it translates every other key,
so a key whose English changed since, or that the catalog lost, is translated again. A plural group is skipped only
when all of its forms are, and is otherwise translated whole. Re-running the same command after a failure, a budget
stop or a killed job therefore pays only for what is missing.

A run that completes for **every** language (the snapshot rule) deletes `src/locales/.sources/`, so the next FULL run
translates everything again. Delete that directory by hand to start a FULL run over before then. A run over some
languages keeps the records. DELTA ignores them, but updates the records that exist for the keys it translates.

### `DRY_RUN=1` — preview with zero token spend

```bash
DRY_RUN=1 pnpm run translate-i18n --full
```

Skips the API and stubs each translation as `"<lang>:<english>"`. **Delete the stub output afterwards**
(`src/locales/<lang>.json` and `src/locales/.sources/`, and restore `.en-snapshot.json` and `.catalogs.json` from
git), or the app offers the stub languages.

## Rolling out the languages

1. Done: the shared pipeline, the seeded `.en-snapshot.json` and an empty manifest.
2. The full run (approve the API cost first): 6,876 keys × 27 languages at 25 keys per request is roughly 8,700
   requests, far past GitHub's 6-hour job limit, so `.github/workflows/i18n-web.yml` splits it. Dispatch it with
   `mode=full` (GitHub → Actions → **i18n translate (web)** → *Run workflow*, or
   `gh workflow run i18n-web.yml -f mode=full`):
   - one job per language (`max-parallel`, default 6) runs `translate-i18n --full <lang> --budget-minutes=300`,
     starting from and pushing its catalog and resume record to the branch `i18n/full-translate-web-progress`;
   - a final job collects every language and runs `--full --budget-minutes=0`. Only when every language is complete
     does that write the snapshot and manifest and delete the resume records, and only then is the PR
     `i18n: full web translation` (branch `i18n/full-translate-web`) opened or updated;
   - a language that ran out of budget ends its job with a notice: dispatch `mode=full` again, and every language
     continues where it stopped (a finished one costs nothing). Repeat until the PR appears.

   After that PR has merged, delete `i18n/full-translate-web-progress`. Locally the same works one machine at a time:
   `ANTHROPIC_API_KEY=… pnpm run translate-i18n --full`, re-run until it exits 0.
3. After that has merged, a push that changes `src/locales/en/**` on `main` runs a delta translation on its own
   (the push trigger in `.github/workflows/i18n-web.yml`).

`mode=delta` (the default) runs the shared single-job workflow and opens or updates the rolling PR
`i18n: update web translations`. Either PR is opened by the workflow's `GITHUB_TOKEN`, so it does not trigger
downstream CI; merging it by hand runs the full CI on `main`.

## Adding a language

1. `@filen/shared/languages` — add it to `SUPPORTED_LANGUAGES` and `LANGUAGE_LABELS` (mobile's literal copy in
   `filen-mobile/src/locales/languages.ts` must follow, with a native release).
2. `@filen/shared/tooling/i18n` — add its English name to `LANGUAGE_NAMES`.
3. Run the pipeline for it. The app offers it once its catalog is near-complete.

The key is read from `process.env.ANTHROPIC_API_KEY` — never hardcoded, never logged.
