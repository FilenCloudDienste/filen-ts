# Global Instructions

## Skill Check (mandatory)

Before starting ANY task, check available skills for relevance.

If there is even a 0.01% chance a skill applies, invoke it before doing anything else.

Never rationalize skipping a skill check with "this is simple enough" or "I already know how.".

## Code Intelligence

Prefer LSP over Grep/Glob/Read for code navigation:

- `goToDefinition` / `goToImplementation` to jump to source
- `findReferences` to see all usages across the codebase
- `workspaceSymbol` to find where something is defined
- `documentSymbol` to list all symbols in a file
- `hover` for type info without reading the file
- `incomingCalls` / `outgoingCalls` for call hierarchy

Before renaming or changing a function signature, use
`findReferences` to find all call sites first.

Use Grep/Glob only for text/pattern searches (comments,
strings, config values) where LSP doesn't help.

After writing or editing code, check LSP diagnostics before
moving on. Fix any type errors or missing imports immediately.

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
