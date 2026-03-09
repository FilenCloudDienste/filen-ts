---
name: verify-changes
description: >
    CRITICAL! Always use after every code modification — including small edits and refactors.
    Runs available checks in order: (1) ESLint on changed files, (2) TypeScript tsc --noEmit,
    (3) tests scoped to changed files. A change is not done until all checks pass. Never
    suppress errors with eslint-disable or @ts-ignore — fix the root cause.
---

# Verify Changes

After **every** code modification, run all available verification checks. A change is not done until checks pass.

## Step 1: Detect Available Checks

This is a monorepo — read the **package-level** `package.json` for the package you're modifying, not just the root:

```
Read(file_path: "/absolute/path/to/packages/<package>/package.json")
# Check "scripts" for: lint, typecheck, type-check, test, check, ci
```

| Check | Look for |
|-|-|
| ESLint | `eslint` in scripts, or `eslint.config.*` present |
| TypeScript | `tsc` in scripts, or `tsconfig.json` present |
| Tests | `test`, `jest`, `vitest` in scripts |

## Step 2: Run Checks

### 1. ESLint

```bash
npx eslint <changed-file> --max-warnings=0
```

Lint changed files first for speed. Run full lint if errors reference other files. Skip if no ESLint config found.

### 2. TypeScript

```bash
npx tsc --noEmit
```

Skip if no `tsconfig.json`.

### 3. Tests

```bash
# Scoped to changed files first
npx jest --testPathPattern=<basename> --passWithNoTests 2>/dev/null

# Or full suite
npm test
```

Skip if no test config or test files.

## Step 3: Handle Failures

- **ESLint**: fix each issue, re-run. Do NOT add `eslint-disable` unless the rule is provably wrong.
- **TypeScript**: fix root cause, not symptoms. No `@ts-ignore` or `@ts-expect-error`.
- **Tests**: determine if failure is from your change or pre-existing. Never delete tests to pass.

## Step 4: Report Status

```
✅ ESLint: clean
✅ TypeScript: no errors
✅ Tests: 42 passed
```

Use ⏭️ for skipped checks, ❌ for failures. Do not mark a task complete while any check shows ❌.
