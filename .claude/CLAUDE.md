# Global Instructions

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
