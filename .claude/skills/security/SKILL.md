---
name: security
description: >
    Filen client threat model. Use when writing or reviewing code that handles secrets, session or
    key material, secure storage, deep links or intents, or links from user content, and before
    flagging a security finding in review.
---

# Filen Threat Model

- The SDK (`@filen/sdk-rs`) owns crypto, auth and networking. Never reimplement any of it in TS.
- Mobile secrets go only through `src/lib/secureStore.ts` (AES-256-GCM file; its key in expo-secure-store, MMKV only as the fallback key store). The key uses `AFTER_FIRST_UNLOCK` deliberately: background tasks run while the device is locked. Never raw MMKV or AsyncStorage for secrets.
- Never log the session blob, keys or other secret-equivalent material, and never put them in errors, traces or URLs.
- Links from content the user did not author: mobile classifies them with `src/lib/untrustedLinks.ts` (allowlist); web note HTML goes through `src/features/notes/lib/sanitizeRichText.ts`.
- Validate deep links and intents. Never read `new URL(x).hostname` (or `host`/`pathname`/`origin`) on `iofilenapp://` links: RN's URL parses those only for http(s) and returns `""`. Parse the raw string, as `src/routes/+native-intent.ts` does.

## Accepted risks (don't flag)

- Web: the SDK session blob is stored plain at rest (`src/lib/sdk/session.ts`); a WebCrypto wrap would need its unwrap key beside it, so the CSP in `vite.config.ts` is the XSS defense.
- Mobile: the SQLite kv is plaintext (op-sqlite `sqlcipher: false`).
- Mobile logs keep decrypted names, paths and queries by product decision; there is no redaction layer.
