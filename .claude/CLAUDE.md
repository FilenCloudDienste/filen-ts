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

## Code navigation and dependencies

- Use the LSP tool for symbol navigation (definition, references, hover); text search only for strings, comments and config.
- Before writing a helper, check `@filen/shared` (`packages/filen-shared`) and the sibling app; shared logic lives there and is never duplicated.
- Dependency versions here are often newer than model training data: check `package.json` and the root `pnpm-lock.yaml`, and read the installed package's types or source under `node_modules` before asserting API behaviour. Cite primary docs only.

## Verifying changes

- Before calling code done, run the package's own scripts; they are what CI runs: `pnpm run lint`, `pnpm run typecheck`, `pnpm test`. `pnpm run verify` runs all three in filen-mobile and at the repo root (recursive). filen-desktop has only `pnpm run build` (lint + tsc).
- Never run a bare `tsc --noEmit` in filen-web: `tsconfig.json` is a solution file (`files: []` plus references) and checks nothing. Its `typecheck` is `tsc -b --noEmit`, and its `lint` includes `prettier --check`.
- Fix root causes; no `eslint-disable` or `@ts-ignore`.
