---
name: security
description: >
    Use when writing/reviewing code that handles: file uploads or filesystem paths,
    credentials/API keys/secrets, cryptography, user input, or authentication.
    Checks for: path traversal, hardcoded secrets, insecure crypto, missing ownership
    checks, and information leakage. Also flags security issues in adjacent code.
---

# Security — Write Secure Code by Default

## Step 0 — Understand existing security patterns

```
Grep(pattern: "auth|validate|sanitize|SecureStore|secureStore", glob: "src/**/*.ts", output_mode: "files_with_matches")
Read(file_path: "/absolute/path/to/package.json")
```

Use what the project already has. Never introduce parallel security mechanisms.

---

## 1. Input Validation

Validate at the boundary — before any use:

- **Type** — correct type? (string, number, boolean)
- **Format** — expected pattern? (UUID, email, filename)
- **Range/length** — within bounds?
- **Allowlist** — one of a known set?

Reject invalid input outright. Never coerce untrusted data.

---

## 2. Path Traversal

Never use unsanitised user input to construct file paths.

```typescript
// ❌ User controls where you read/write
readFile("/uploads/" + userFilename)

// ✅ Resolve and verify confinement
const base = resolve("/uploads")
const requested = resolve(base, userFilename)
if (!requested.startsWith(base + "/")) reject("Invalid path")
```

---

## 3. Secrets and Credentials

- **Never hardcode secrets** — read from environment or secure storage
- **Never log secrets** — explicitly allowlist safe fields before logging
- **Never put secrets in URLs** — query params are logged everywhere
- Before committing, verify no secrets are staged

---

## 4. Cryptography

| Purpose              | Use                      | Never use                        |
| -------------------- | ------------------------ | -------------------------------- |
| Password hashing     | argon2id, bcrypt, scrypt | MD5, SHA-\*, plain text          |
| Symmetric encryption | AES-256-GCM              | ECB mode, RC4, DES               |
| Secure random tokens | OS CSPRNG                | Math.random(), time-seeded PRNGs |

- Use standard implementations — never roll your own
- Always use authenticated encryption (AES-GCM)
- Never reuse an IV/nonce with the same key
- This project uses `react-native-quick-crypto` for native CSPRNG

---

## 5. Platform-Specific

**All packages:** the Rust SDK (`@filen/sdk-rs`) handles all server communication, encryption, and auth. Never reimplement crypto or API calls in JS/TS — delegate to the SDK.

**Mobile (filen-mobile):**

- Use `expo-secure-store` (Keychain/Keystore) for sensitive data — never `AsyncStorage` or unencrypted MMKV for tokens/credentials
- Validate all data received via deep links or intents

**Web (filen-web) / Desktop (filen-desktop):**

- Never store tokens in `localStorage` — use `HttpOnly` cookies or secure in-memory storage
- Be aware that Electron's renderer process is a web context — same XSS risks apply

**All platforms:**

- Never log tokens, keys, passwords, or user data in production

---

## 6. Error Handling

Errors must never reveal: stack traces, internal paths, query structure, framework versions, or internal service names.

```typescript
// ❌ Full error detail exposed
return { error: exception.message, trace: exception.stack }

// ✅ Log internally, return generic message
logger.error(exception)
return { error: "An unexpected error occurred" }
```

---

## When You Spot a Vulnerability

Flag it immediately, even if outside the current task scope. Never silently work around it.
