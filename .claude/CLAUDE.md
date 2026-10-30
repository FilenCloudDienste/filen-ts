# Global Instructions

Performance, efficiency and the lowest CPU/RAM usage are always the top priority in design and implementation choices; API requests are minimized by reusing data already held.

## Rust SDK (`@filen/sdk-rs`)

The Rust SDK is the backbone of all Filen apps. It handles everything below the UI layer — **never reimplement** what it already provides.

### What the SDK owns

- **Networking** — all API requests, WebSocket connections, rate limiting
- **Concurrency** — parallel uploads/downloads with configurable limits
- **Retries** — transient failure handling built into the Rust layer
- **Encryption** — all crypto in Rust, JS only sees decrypted types
- **Auth** — login, 2FA, sessions

### Rules

- **Never reimplement crypto or API calls in JS/TS** — always delegate to the SDK
- **Never add retry/rate-limit/concurrency logic in JS** — the SDK handles this internally

## Repository layout

- pnpm workspace; every package lives in `packages/<name>` and is named `@filen/<name without filen->`: `filen-web`, `filen-mobile`, `filen-desktop` (apps), `filen-shared` (logic shared by the apps), `filen-office` (document engines and editors), `filen-spellcheck` (Rust/wasm spellchecker), `filen-assistant-eval` (model eval harness, not shipped). `packages/filen-mobile/CLAUDE.md` and `packages/filen-desktop/CLAUDE.md` hold per-app guidance; the other packages document themselves in their README.
- Git submodules (`.gitmodules`) are other repositories: `filen-rs`, `filen-ios-file-provider` and `filen-android-documents-provider` under filen-mobile, `filen-rs` and `filen-ios-file-provider` under filen-desktop. Never edit them from here.
- Workspace settings live only in `pnpm-workspace.yaml`, never in a `package.json`: `overrides`, `packageExtensions`, `allowBuilds`, `patchedDependencies` (patch files in the root `patches/`) and `minimumReleaseAge` exclusions. Third-party versions younger than pnpm's one-day `minimumReleaseAge` do not install; `@filen/*` is exempt by name.

## Code navigation and dependencies

- Use the LSP tool for symbol navigation (definition, references, hover); text search only for strings, comments and config.
- Before writing a helper, check `@filen/shared` (`packages/filen-shared`) and the sibling app; shared logic lives there and is never duplicated.
- Dependency versions here are often newer than model training data: check `package.json` and the root `pnpm-lock.yaml`, and read the installed package's types or source under `node_modules` before asserting API behaviour. Cite primary docs only.

## Verifying changes

- Before calling code done, run the package's own scripts; they are what CI runs: `pnpm run lint`, `pnpm run typecheck`, `pnpm test`. `pnpm run verify` runs all three in filen-mobile, filen-desktop and at the repo root (recursive); the other packages have the three scripts only. Check exit codes, not output.
- Never run a bare `tsc --noEmit` in filen-web or filen-desktop: their `tsconfig.json` is a solution file (`files: []` plus references) and checks nothing. Their `typecheck` is `tsc -b --noEmit`, and their `lint` includes `prettier --check`.
- Fix root causes; no `eslint-disable` or `@ts-ignore`.
