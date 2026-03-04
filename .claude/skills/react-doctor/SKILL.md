---
name: react-doctor
description: >
    Always use after modifying any React or React Native component (*.tsx, *.jsx), finishing a
    feature, or fixing a bug in a React/RN project. Runs: npx -y react-doctor@latest . --verbose
    --no-dead-code --offline --no-ami — a static analysis tool that scores the codebase 0-100
    on security, performance, correctness, and architecture. Show results to the user; only fix
    reported issues if explicitly asked. Skip for non-React files (pure TS utilities, config,
    Rust, scripts).
version: 1.0.0
---

# React Doctor

Scans your React codebase for security, performance, correctness, and architecture issues. Outputs a 0-100 score with actionable diagnostics.

## Usage

```bash
npx -y react-doctor@latest . --verbose --no-dead-code --offline --no-ami
```

Flags:
- `.` — scan the current directory (project root)
- `--verbose` — show detailed diagnostics per file, not just the summary score
- `--no-dead-code` — skip dead code detection (slow, and often produces false positives in RN)
- `--offline` — do not phone home / check for updates
- `--no-ami` — skip the "Are you my instance?" cloud check (irrelevant for local development)

## Output

Produces a 0-100 score across four dimensions:
- **Security** — XSS vectors, unsafe innerHTML, insecure data handling
- **Performance** — unnecessary re-renders, missing keys, large bundle imports, missing memo
- **Correctness** — missing error boundaries, improper hook usage, missing dependency arrays
- **Architecture** — component complexity, prop drilling depth, coupling issues

## Workflow

Run after making changes to catch issues early. Show results to the user and only fix reported issues if explicitly asked to do so.
