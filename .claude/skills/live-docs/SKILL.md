---
name: live-docs
description: >
    Use before writing/reviewing code that calls into any external library, API, or framework.
    Training data goes stale — fetch version-specific docs before writing. Identify the
    exact installed version from package.json/Cargo.toml first, then fetch matching docs.
---

# Live Documentation Lookup

Training data goes stale. APIs change. Before writing code that depends on any external library, fetch the current docs.

## Step 1 — Identify installed versions

```
Read(file_path: "/absolute/path/to/package.json")
```

For lock file details:

```bash
grep -A 2 '"<package>"' package-lock.json
```

For Rust crates:

```bash
grep -A 2 'name = "<crate>"' Cargo.lock
```

**The version number matters.** The same library at v1 and v2 can have completely different APIs.

## Step 2 — Find the right docs

| Ecosystem        | Doc location                        |
| ---------------- | ----------------------------------- |
| npm (JS/TS)      | `npmjs.com/package/<n>` linked docs |
| crates.io (Rust) | `docs.rs/<n>/<version>/`            |

For version-pinned docs:

- `docs.rs/<crate>/<version>/` — Rust, always version-pinned
- GitHub releases: `github.com/<org>/<repo>/releases`
- GitHub tags: `github.com/<org>/<repo>/tree/v<version>`

## Step 3 — Fetch before you write

Search specifically — include library name, version, and the exact API:

```
expo-file-system 55 Directory API
react-native-reanimated 4.x useAnimatedStyle
@tanstack/react-query 5 useMutation options
```

### What to look for

- Function/method signatures — params, types, order, required vs optional
- Return types — especially async or error-returning APIs
- Breaking changes since the version you know
- Required setup — imports, initialization, config
- Deprecations — old way may compile but new way is correct

## Step 4 — Apply what you found

1. Use exact signatures from docs — don't guess missing params
2. Match the installed version — don't write against a different version's API
3. Check required setup steps
4. Flag outdated versions if significantly behind

## High-churn categories — always fetch

- AI/LLM SDKs (OpenAI, Anthropic)
- Mobile platform APIs (Expo, iOS, Android)
- React Native libraries (Reanimated, Gesture Handler, Flash List)
- Any library after a major version bump

## When docs are unavailable

1. GitHub README, releases, source code
2. Read type signatures from `node_modules` or the repo directly
3. If unverifiable — tell the user, leave a TODO comment
