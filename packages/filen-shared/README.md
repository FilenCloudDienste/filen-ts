# @filen/shared

Plain TypeScript logic shared by the Filen apps. It is never published or built: `filen-web`, `filen-mobile`, `filen-desktop`, `filen-office` and `filen-assistant-eval` depend on it as `workspace:*` and compile its sources directly, so a change here reaches every client at once.

Logic two clients need lives here, written once. Before writing a helper in an app, check this package; when an app grows logic another one needs, move it here instead of copying it.

## What lives here

| Path             | What                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/*.ts`       | Drive (listing, sorting, ancestry, jobs and their progress, hidden items, `.filen`), notes, chats, contacts, photos, playlists, file types and icons, link policy, the persisted session schema, the desktop preload contract, and small utilities (`run`, `semaphore`, `naturalSort`, `misc`) |
| `src/assistant/` | The assistant's tools, guard, prompts and loop (`@filen/shared/assistant`)                                                                                                                                                                                                                     |
| `src/videos/`    | Video library: container probing, naming, subtitles and track selection (`@filen/shared/videos`)                                                                                                                                                                                               |
| `src/dom/`       | DOM-only helpers: rich-text and spreadsheet clipboard sanitizers, Quill compatibility (`@filen/shared/dom`)                                                                                                                                                                                    |
| `src/emojis/`    | Filen's custom emoji pack (`@filen/shared/emojis`)                                                                                                                                                                                                                                             |
| `src/tooling/`   | Node-only build tooling: license notices, the i18n pipeline, the test budget (`@filen/shared/tooling`, `/tooling/i18n`, `/tooling/testBudget`)                                                                                                                                                 |
| `src/tests/`     | Vitest tests                                                                                                                                                                                                                                                                                   |

The entry points are the `exports` map in `package.json`; `src/index.ts` is the main barrel.

## Rules

- Platform-free: everything outside `src/tooling/` runs on Hermes, in the browser and in Node, so it imports no Node, React, React Native or Expo module. `src/dom/` may use DOM types. ESLint enforces this.
- Relative imports stay inside the package (`./`, never `../` out of it), and nothing in `src` imports the package's own barrel.
- Networking, crypto and auth belong to the Rust SDK (`@filen/sdk-rs`), not here.

## Commands

Install once at the repo root (`pnpm install`); these run from this directory.

| Command              | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| `pnpm run lint`      | ESLint                                                                        |
| `pnpm run typecheck` | Type-check the library, the tests, the DOM helpers and the tooling separately |
| `pnpm test`          | Run the unit tests (Vitest, `src/**/*.test.ts`)                               |
