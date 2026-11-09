# @filen/office

Document engines and editors shared by the Filen apps. `pnpm run lint`, `pnpm run typecheck` and `pnpm test` are what CI runs.

## DOCX viewer

- `@filen/office/dom/docx` runs the engine (package → model → styles → fonts → layout) and streams pages as plain data: `serveDocxWorker` + `workerDocxHost` over a worker (web, one worker per document), or `inThreadDocxHost` with `windowServices` on the page's own thread (Expo DOM components). The document's bytes stay with the caller; the engine reads ranges.
- It also holds the viewer's controls as serialisable commands and state (`DocxViewerCommand`, `DocxViewerState`, `DOCX_VIEWER_COMMANDS`): apps draw their own toolbars, a native toolbar can send them over the DOM-component bridge (`parseDocxViewerCommand`).
- `@filen/office/react/docx` is unstyled: `useDocxDocument`, `<DocxPages>` (virtualised, real DOM text), `useDocxViewer`, find and link helpers. `@filen/office/css/docx.css` is structural; every visual value is a `--fo-*` variable.
- Apps serve `assets/fonts/**` (with each family's licence file) from their own origin and pass its URL to `workerServices`; fonts are registered from bytes, so `font-src 'self'` holds.
- Apps that bundle the React layer from source dedupe `react` and `react-dom` (Vite `resolve.dedupe`).

## DOCX editing core

- `@filen/office/core/docx/edit` turns a story into a ProseMirror document whose nodes and marks keep their source items, so a writer can copy whatever was not edited as its original bytes. Blocks that cannot be edited safely become locked blocks. Invariant plugins keep markers, section breaks, fields and source identity intact, and `DocxEditorSession` is the headless command/state API (`DOCX_EDITOR_COMMANDS`, `parseDocxEditorCommand`, `snapshot()`).
- `@filen/office/core/docx/spelling` is the spelling of an editing session, headless: `DocxSpelling` gives the misspelled and repeated words as ranges (`marks()`, `subscribe()`; pass them to `DocxEditor`'s `marks`) and the actions on them (`spellingAt`, `suggestions`, `replaceWord`, `ignoreAll` for the session, `addToDictionary`). Language comes from each run's `w:lang` slot for the word's script; Word's proofing rules apply (noProof, hidden and deleted text, `w:hideSpellingErrors`, uppercase words, words with digits, addresses). The app supplies the `SpellingChecker` (web: `@filen/spellcheck`); words are found with the UAX #29 word segmenter in `core/text`.
- ProseMirror (`prosemirror-model`, `-state`, `-transform`, `-history`) is an optional peer dependency. An app that ships the editor adds these packages as its own dependencies, dedupes them with React (Vite `resolve.dedupe`, Metro `resolveRequest`), and adds ProseMirror's MIT notice to its third-party notices.

## Markdown

- `@filen/office/core/markdown` holds the editing commands for a markdown source (`toggleInlineMarker` with `MARKDOWN_MARKERS`, `toggleItalic`, `insertLink`) as CodeMirror `StateCommand`s, and `markdownUrlTransform`: a link or image URL survives only if `@filen/shared`'s link policy allows it.
- `@filen/office/react/markdown` is the rendered view, unstyled: `<MarkdownView>` renders CommonMark and GFM with no raw HTML, takes the host's element slots (`components`, a module-scope object) and its `urlTransform` (the link policy by default). Opening links, and asking before an untrusted domain, is the host's job.
- `react-markdown`, `remark-gfm` and `@codemirror/state` are optional peer dependencies (MIT). An app that uses these entry points adds them as its own dependencies, dedupes them (Vite `resolve.dedupe`, Metro `resolveRequest`), and adds their notices to its third-party notices.

## PDF

- `@filen/office/dom/pdf` opens a PDF with the pdf.js module the host passes in (typed structurally; web: `pdfjs-dist` with a worker script; mobile: the legacy build with the in-thread worker). Assets come from `none`, `urls` or `inline`; the source is the whole file or ranged reads. A password loop runs on one loading task, and errors map to a closed set. Links pass `@filen/shared`'s link policy, in-document destinations resolve to a page and the point on it (the zoom they name is ignored), and find runs over the text content.
- `@filen/office/react/pdf` is headless: `<PdfPages>` (virtualised pages with pdf.js's text layer), `usePdfDocument` and `usePdfViewer`, with commands and state like the DOCX viewer. `@filen/office/css/pdf.css` is structural; its colours are `--fo-pdf-*` variables.
- `pdfjs-dist` is an optional peer dependency (Apache-2.0); this package bundles none of it. An app that uses these entry points adds it as its own dependency, dedupes it, and adds its notice.

## Code editor

- `@filen/office/core/code` maps a lowercased file extension to a code language (234 extensions, 123 languages; DOM-free, Hermes-safe). `@filen/office/dom/code` holds the CodeMirror pieces: `codeLanguageSupport` (every grammar, each built on first use), `codeTheme` (chrome and syntax colours as `--fo-code-*` variables; light falls back to CodeMirror's default style, `codeSyntaxVariables("dark")` is One Dark), `codeEditorSetup`, `codeKeymap`/`openReplacePanel`, and `mountCodeCompare`. `@filen/office/react/code` is the headless `<CodeEditor>`. The CodeMirror packages, `@lezer/highlight` and `@replit/codemirror-lang-{nix,solidity,svelte}` are optional peer dependencies (MIT); an app that uses these entry points adds them as its own dependencies, dedupes the stateful ones, and adds their notices.

## Presentations

- Formats: PresentationML (`.pptx`, `.pptm`, `.potx`, `.potm`, `.ppsx`, `.ppsm`) and ODF (`.odp`, `.otp`) are read and saved in their own format; PowerPoint 97–2003 (`.ppt`, `.pps`, `.pot`) is read through the pptx it converts to and saves as a new file. Encrypted packages open with a password; rights-managed files are refused.
- Code: `core/presentation` (the format-neutral model, edit ops and commands, text, render and pages), `core/pptx`, `core/odp` and `core/ppt` (readers and writers), `core/anim` (timing trees, the timegraph the show samples, presets, media timing), `core/smartart` (layouts, editing and the gallery generated from `assets/smartart` by `gallery/generate.ts`), `core/convert/presentation`. `@filen/office/dom/presentation` is the worker engine: one capability per file under `engine/`, served over `protocol.ts`, sliced by `scheduler.ts`. `@filen/office/react/presentation` is the unstyled UI (slide view, rail, editing, notes, ink, show and presenter view); `@filen/office/css/presentation.css` is structural.
- Edits are ops in families (shape, text, table, picture, media, chart, SmartArt, ink, comments, notes, slides, design, transitions, timing, motion paths), each with an inverse that holds bytes, so undo crosses saves.
- Saving is lossless: unedited parts, shapes and attributes are copied as their source bytes. Proof gate 1 runs before the first edit on a slide: every source shape is written as if it were dirty and compared with its source at XML-meaning level; a shape that does not come back the same is locked (`proofFailed`) and keeps its bytes. Other locks: `alternateContent`, `unknownFrame`, `gate`, `budget`, `master`. Proof gate 2 checks the package as stored before the upload may end: in memory and read back up to the in-memory limit, streamed with every copy CRC-checked above it. After a save the session rebases onto the saved file.
- A signed, Strict, write-protected or malformed deck opens view-only (`GateReason`). Every refusal is a typed `PresentationRefusal` with a detail, never a silent drop.
- Conversions (pptx ↔ ODP, ppt → pptx or ODP, a view-only deck to a Transitional copy) write through the fresh writers over the open model, so unsaved edits convert; what the target cannot hold is listed in a `ConversionLoss` report.
- Export: a tagged PDF (PDF/UA-1; slides, notes pages or handouts) and PNG or JPEG images (several as a stored zip), both drawn from the same display lists as the screen.
- Slide show: `react/presentation/show`. One controller drives the stage, presenter view, keys, clickers and touch. Timings, triggers, media trim and bookmarks are compiled once per slide and sampled per frame.

## Real-world corpus

The corpus holds licensed real-world files in every supported format (DOCX, XLSX, CSV/TSV, PPTX, ODT, ODS, ODP, RTF, DOC, XLS, PPT and their template/macro variants); the corpus tests (`src/tests/*Corpus.test.ts`) run each engine over its own family. The files are never committed; `corpus/manifest.json` lists each one with its download URL, licence, size and SHA-256, and `corpus/README.md` lists the sources, licences, families and totals. `src/tests/corpusFiles.test.ts` checks every fetched family, with an engine or not, against the manifest.

```sh
pnpm run corpus:fetch   # downloads ~613 MB into .corpus/ (gitignored); re-runs only fetch what is missing
pnpm test               # the corpus tests now run instead of skipping
```

- Every file is verified against its SHA-256 before it is written; files no longer in the manifest are removed.
- `--strict` fails on any unavailable file (by default up to 2 %, at most 10, may be), `--check-remote` also checks that the sources of cached files still exist, `--dir <directory>` fetches elsewhere, `--family pptx,ppt` fetches only some families.
- The tests look for the corpus in `FILEN_OFFICE_CORPUS` (must exist when set), then `.corpus/`, then the gitignored `packages/filen-web/docs/office/corpus` where it was first assembled.
- `FILEN_OFFICE_UNICODE_FULL=1` adds the full Unicode conformance files, downloaded by `pnpm exec tsx src/scripts/unicodeTables.ts`.
- `pnpm run corpus:manifest --from <MANIFEST.json>` regenerates `corpus/` when the corpus is rebuilt.

CI runs all of it in `.github/workflows/office-corpus.yml`, on changes to this package and nightly.

### DOCX editing fuzzers and digests (`src/tests/fuzz`)

Skipped unless turned on; each job runs in its own Node process.

```sh
FILEN_OFFICE_FUZZ=3 FILEN_OFFICE_FUZZ_SEED=21 pnpm exec vitest run src/tests/fuzz/paged.fuzz.test.ts   # 3 seeds × sync, race per file
FILEN_OFFICE_FUZZ=8 FILEN_OFFICE_FUZZ_SEED=8 pnpm exec vitest run src/tests/fuzz/damage.fuzz.test.ts   # 8 sequences per file
FILEN_OFFICE_DIGEST=/tmp/viewer.json pnpm exec vitest run src/tests/fuzz/viewer.fuzz.test.ts         # writes, then compares
```

- Paged fuzz: random user edits through the paged editor; after every settled step the pages shown (lines, and placed objects with their box, layer, wrap, z-order, rotation and crop) must equal a fresh layout of the saved file. Damage fuzz: raw transactions saved through Gates 1 and 2 and read back by an independent zip/XML reader (its range markers are those the editor holds, those in blocks and atoms written as their bytes counted in those bytes, text boxes included: comment commands and resolved moves add and take some out; bookmarks and permission ranges must also all survive from the source; `selftest` mode drops a bookmark from each saved file and types into the editor after the save, both of which must be reported); gate refusals are counted, anything else fails. Both fail an editable document no op changed; a run that has changed nothing keeps drawing (paged: up to 80 more steps, damage: up to 16 more sequences) before it counts as one. Viewer digest: the unedited layout of every document against a baseline written by the first run.
- `FILEN_OFFICE_FUZZ_FILTER` (file name part), `_STEPS`, `_OPS` (op names), `_MODES` (paged: `sync,race,proof`; damage: `stories,undo,blockmove,undoall,xsd,selftest`), `_VIEW` (`final`, `markup`, `original`), `_JOBS` and `_OUT` (JSON lines) tune a run. One job: `FILEN_OFFICE_FUZZ=1 node --import tsx src/tests/fuzz/run.ts paged <file> <seed> <mode>` or `run.ts damage <file>`.
- Edits live in `src/tests/fuzz/ops/`, one file per feature; ops with a `script` also form the scripted edit suite of `docxWriteCorpus.test.ts`.

Failures the fuzz finds and not fixed yet go here, each with the command that repeats it (run from this package). None are open.

### Opt-in oracles

Each skips unless its variables are set; run from this package.

```sh
FILEN_OFFICE_FUZZ_SAVES=<dir> pnpm exec vitest run src/tests/fuzz/script.fuzz.test.ts                    # keep saves for the oracles
FILEN_OFFICE_FUZZ_SAVES=<dir> FILEN_OFFICE_SOFFICE=<soffice>[,<soffice>] pnpm exec vitest run src/tests/docxInteropLibreOffice.test.ts
pnpm exec tsx src/tests/oracles/xsd.ts --fetch && pnpm exec vitest run src/tests/docxWriteSchema.test.ts src/tests/pptxWriteSchema.test.ts
FILEN_OFFICE_OOXML_VALIDATOR=<OpenXmlValidate.dll> FILEN_OFFICE_DOTNET=<dotnet> pnpm exec vitest run src/tests/docxOpenXmlSdk.test.ts
FILEN_OFFICE_SOFFICE=<soffice>[,<soffice>] pnpm exec vitest run src/tests/oracles/sheet/sheetLibreOffice.test.ts
pnpm run generate:wml-order --fetch && pnpm exec vitest run src/tests/oracles/sheet/sheetSchema.test.ts
FILEN_OFFICE_OOXML_VALIDATOR=<OpenXmlValidate.dll> FILEN_OFFICE_DOTNET=<dotnet> pnpm exec vitest run src/tests/oracles/sheet/sheetOpenXmlSdk.test.ts
FILEN_OFFICE_OOXML_VALIDATOR=<OpenXmlValidate.dll> FILEN_OFFICE_DOTNET=<dotnet> pnpm exec vitest run src/tests/xlsxWriteOracles.test.ts   # xmllint part runs with the schemas alone
FILEN_OFFICE_XLSX_PERF=1 pnpm exec vitest run src/tests/xlsxWritePerf.test.ts
FILEN_OFFICE_SHEET_CACHED=1 pnpm exec vitest run src/tests/oracles/sheet/excelCached.test.ts
pnpm run oracles:sheet-suites && FILEN_OFFICE_SOFFICE=<soffice> pnpm exec vitest run src/tests/oracles/sheet/functionSuites.test.ts
FILEN_OFFICE_LO_CACHE=<dir> pnpm exec vitest run src/tests/showOracle.test.ts src/tests/animOracle.test.ts src/tests/presentationTextOracle.test.ts
FILEN_OFFICE_OOXML_VALIDATOR=<OpenXmlValidate.dll> FILEN_OFFICE_DOTNET=<dotnet> FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar> FILEN_OFFICE_SOFFICE=<soffice> pnpm exec vitest run src/tests/presentationShowOracle.test.ts src/tests/presentationTransitionsOracle.test.ts src/tests/animPresetMatrix.test.ts
FILEN_OFFICE_PPTX_WRITE_OUT=<dir> FILEN_OFFICE_ODP_WRITE_OUT=<dir> pnpm exec vitest run src/tests/pptxWriteCorpus.test.ts src/tests/odpWriteCorpus.test.ts
HERMES_CLI=<hermes> pnpm exec tsx src/scripts/hermes/run.ts
FILEN_OFFICE_SOAK=<minutes> pnpm exec vitest run src/tests/docxSoak.test.ts
```

- Saves: `FILEN_OFFICE_FUZZ_SAVES=<dir>` makes the scripted suite and the fuzzers keep each edited save with a JSON sidecar (our text and counts) and `<dir>/manifest.json`; `_EVERY=<k>` keeps one run in k, `_MAX_BYTES` (5 MB) skips bigger sources.
- LibreOffice: converts every kept save and its original to PDF, ODT, flat ODT, text and DOCX (and the ODT back to DOCX) and compares what each edit added and removed, text and structure, with our model; LibreOffice's own readings are listed with their reason in `src/tests/interop/accepted.ts`. `FILEN_OFFICE_INTEROP_PER_FAMILY` (50), `_LIMIT`, `_JOBS` (4) and `_WORK` (keeps outputs and `report-<office>.json`) tune a run.
- Schemas: the WordprocessingML and SpreadsheetML schemas come from `pnpm run generate:wml-order --fetch` (the same pinned Transitional archive; `sml.xsd` and the drawing schemas it imports carry their own pins in `src/scripts/smlOrder.ts`), the OPC and Dublin Core ones from `xsd.ts --fetch` (or `FILEN_OFFICE_OPC_SCHEMAS`); a save may add no validity error to its source. `pnpm run generate:sml-order` writes the SpreadsheetML child-order table.
- Open XML SDK: build `tools/openxml-validate` with `dotnet restore --locked-mode && dotnet build -c Release --no-restore` (output under `node_modules/.cache`); it opens `.xlsx`, `.xlsm`, `.xltx` and `.xltm` as spreadsheets and everything else as Word documents; a save may add no error to its source but those allowlisted, with their reasons, in `allow.json`.
- Spreadsheets in LibreOffice (`src/tests/oracles/sheet/`): each profile is pinned to en-US, never updates links or runs macros, and sets recalculation on load explicitly (`never` by default: the file's cached results are shown). `exportShown` gives every sheet "as shown" (CSV export) with each cell's background aligned to A1 (HTML export; 26.8 applies every conditional format, 7.5 rule fills but not color scales). The UNO runner (`unoSheets.ts`, `uno/sheet.py`, the install's bundled Python run with `-I`) loads a copy, hard-recalculates it (`calculateAll`; not a workbook calling WEBSERVICE, STOCKHISTORY, RTD or DDE), dumps every non-empty cell's value, type and shown text, replays insert/delete rows and columns, sort and sheet delete/move, dumps again and stores the result as xlsx. On macOS the 26.8 bundled Python can be killed at exec: such an install still converts, and the runner takes the next install whose Python runs.
- xlsx saves (`xlsxWriteOracles.test.ts`): every corpus workbook gets one edit across the writer's surface (a changed cell, a new row of every cell kind with a new shared string, style and formula, a merge, a frozen pane, a column, a tab colour, sheet protection, full recalculation on load); each rewritten SpreadsheetML/OPC part may add no xmllint error to its source part (Strict parts excepted: the schemas are Transitional) and the package no Open XML SDK error but the allowlisted ones. `FILEN_OFFICE_XLSX_ORACLE_LIMIT` caps the workbooks, `FILEN_OFFICE_XLSX_ORACLE_FILES` (comma-separated substrings) picks them. `xlsxWritePerf.test.ts` builds a 1M-cell workbook and checks the one-cell-edit save: this thread's CPU ≤ 0.6 s, only the edited part deflated, peak ≤ 2× the edited part.
- pptx saves (`pptxWriteSchema.test.ts`): the blank presentation and every theme variant, as written and through the fresh writer, have no xmllint error in a PresentationML, DrawingML or OPC part; over the corpus, each part a splice save of the shape and slide edit set rewrites may add no error to its source part, and each part it adds (duplicated slides and their charts) or a fresh rewrite writes no error beyond the source deck's total. PowerPoint's own parts (modern comments and their authors) are left to the Open XML SDK oracles.
- Excel cached values (`excelCached.ts`): in a workbook Excel calculated, every `<f>` cell's cached `<v>` is Excel's result; a recalculation is compared against them (relative 1e-9; text, booleans and errors exactly; volatile functions and external references left out; `CachedComparison` tallies mismatches by function). A workbook counts only when its corpus source is not a library's or another suite's test files (xlsxwriter, poi, closedxml, libreoffice, openxml-sdk), app.xml names Microsoft Excel, a calcChain or a calcPr calcId without fullCalcOnLoad shows Excel calculated it, calcMode is not manual, and some `<f>` cell has a cached value. `FILEN_OFFICE_SHEET_CACHED=1` sweeps the corpus.
- Function suites (`functionSuites.ts`, `functionCases.ts`): LibreOffice's `sc/qa/unit/data/functions` (MPL-2.0, the 26.8.1.1 commit, set-pinned), formulajs's tests (MIT, 4.6.1, per-file pins) and POI's function workbooks (Apache-2.0, 5.5.1, per-file pins) are fetched into `node_modules/.cache` (`FILEN_OFFICE_SHEET_SUITES` names another directory) and turned into `{ function, inputs, expected }` cases at test time: formulajs's test files are parsed, never run; the workbooks are converted to xlsx by the newest LibreOffice. `FILEN_OFFICE_SHEET_SUITES_LIMIT` converts only the first n LibreOffice files.
- Presentations in LibreOffice: `FILEN_OFFICE_LO_CACHE` names a cache of LibreOffice 7.5's reading of each corpus deck (its UNO model as JSON, a PNG and a background-only PNG per slide, a PDF), keyed by the file's SHA-256 and built by `src/tests/oracles/presentation/lo.ts build` around a UNO export script (`--script`); the show, animation and text oracles compare our model and rendering against it (`FILEN_OFFICE_SHOW_MISSES`, `FILEN_OFFICE_ANIM_MISSES` and `FILEN_OFFICE_TEXT_REPORT` write what differs). The save oracles write each saved deck and require no Open XML SDK or ODF validator error its source lacks, and that LibreOffice reads back what we wrote; the `*_OUT` directories keep the decks for jing against the ODF 1.3 schema.
- Hermes: bundles the core's open/layout/edit/save scenario as the mobile release build does and compares Hermes's results with V8's byte for byte; without `HERMES_CLI` the bundle is only compiled with `hermesc`.
- Soak: a long editing session, run until the given minutes pass; memory grows with the content only, the undo history holds at most one copy of the content, key p95 drifts at most 20 %, a save costs what was edited since the open, no save fails or has a task over 50 ms of CPU, and the last save reopens with the session's text.
