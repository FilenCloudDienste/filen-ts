# Spreadsheet fuzz, oracles and benches

What runs by default and what is opt-in, for the xlsx session (`core/sheet`, `core/xlsx`).

## Default (every `pnpm test`)

| File                             | What                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sheetFuzz.test.ts`              | Command sequences over the fixtures (`fixtures.ts`: rich, unnamed, bare), 6 seeds × sync and race, 16 steps. Grid-edge cells and range-valued formulas are left to the long run. |
| `sheetFuzzRegressions.test.ts`   | Sequences the fuzz found, as plain tests.                                                                                                                                        |
| `sheetE2e.test.ts`               | One session through the in-thread host over every command family, its save and a fresh session on it.                                                                            |
| `sheetOracleCached.test.ts`      | The recalculation harness (`recalc.ts`) on a synthetic workbook.                                                                                                                 |
| `sheetOracleLibreOffice.test.ts` | Without LibreOffice, only that edited saves can be made.                                                                                                                         |

The invariant at every checkpoint (`harness.ts`): the save passes its gate; read back without the engine
(`compare.ts`, over the oracles' `xlsxCells.ts`) it equals the session's model: cells, cached results, formulas,
style ids, rows, columns, merges, sheets, defined names, cell formats, fonts and number formats; and a fresh session
on it shows the same text and input in the held tiles. After undoing everything, the save holds what the source
held, and every part but the append-only ones (styles, shared strings, the calculation chain with its relationship
and content type) keeps its bytes. Every command answers with a change or a typed refusal (`ops.ts`
`KNOWN_REFUSALS`); refusals are tallied, never findings. An exception, a rejection or a call that does not answer
within 60 s is a finding.

## Opt-in

| Variable                                     | Run                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FILEN_OFFICE_SHEET_FUZZ=<sequences>`        | The long run: the fixtures and every corpus spreadsheet up to 5 MB, the sequences spread over workbooks and modes, each workbook's seeds in a Node process of its own (`run.ts`). Also `_SEED`, `_FILTER`, `_STEPS` (16), `_MODES` (sync,race), `_FAMILIES` / `_OPS` (names in `ops.ts`), `_EDGES=0`, `_RANGES=0`, `_JOBS` (at most 4), `_MAX_BYTES`, `_OUT=<file.jsonl>` (every sequence's result). |
| `FILEN_OFFICE_SHEET_RECALC=1`                | Our full recalculation against Excel's cached results over the Excel-calculated corpus (`excelCached.ts` selects 98 workbooks, 1.26M formula cells). `_MIN` (0.985) is the rate it must reach; `_OUT=<file.json>` keeps mismatches by function and kind, root causes, examples and the formulas the engine fell back on.                                                                             |
| `FILEN_OFFICE_SOFFICE=<soffice>[,<soffice>]` | LibreOffice on edited saves: every install opens and converts them to ods, csv and pdf; the UNO runner's hard recalculation equals ours for the functions we calculate. `FILEN_OFFICE_SHEET_LO_CORPUS=<count>` adds corpus workbooks, `_LO_SCRATCH=<dir>` holds profiles and copies, `_LO_MIN` (0.99).                                                                                               |

The 20,000-sequence gate: `FILEN_OFFICE_SHEET_FUZZ=20000 FILEN_OFFICE_SHEET_FUZZ_OUT=sheet-fuzz.jsonl pnpm vitest run src/tests/sheetFuzz.test.ts -t "long run"`
(about 1,000 sequences an hour on 4 processes over corpus workbooks up to 5 MB, so most of a day; `_FILTER` and
`_MAX_BYTES` narrow it).

Replaying one sequence:
`FILEN_OFFICE_SHEET_FUZZ_STEPS=16 node --import tsx src/tests/fuzz/sheet/run.ts <corpus file | fixture:rich> <seed> 1 <sync|race>`.

## Benches

- `node --expose-gc --import tsx src/bench/sheetBench.ts <fixture> [--keys=50] [--json]`: open, first tile, proof,
  engine, keystroke commits, inserted row, scrolled tiles, save after one edit and after everything, each with
  this thread's CPU time, retained memory and message sizes, beside the previous engine's numbers. The fixtures are
  the baseline's (100k×10 values, with formulas without and with results, 300k×10).
- `node --expose-gc --import tsx src/bench/sheetSoak.ts <workbook.xlsx> [--ops=5000] [--save-every=250] [--json]`: a
  long session with a save every 250 operations: retained memory, the history's weight, save CPU and key p95 drift.
