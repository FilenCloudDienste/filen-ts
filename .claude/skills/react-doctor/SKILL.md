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

## Usage example

```bash
npx -y react-doctor@latest . --verbose --no-dead-code --offline --no-ami
```

## Workflow

Run after making changes to catch issues early. Show results and only fix issues if prompted to do so, otherwise skip.
