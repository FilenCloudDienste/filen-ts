---
name: code-style
description: >
    CRITICAL! Always use before writing or modifying any code. Reads the cached style index
    at $CLAUDE_PROJECT_DIR/.claude/code-style-index.json for exact style rules. Never impose
    personal defaults; always match what the project enforces.
---

# Code Style Matching

Before writing or modifying **any** code, match the project's exact code style.

## Step 1: Load the Cached Style Index

```
Read(file_path: "$CLAUDE_PROJECT_DIR/.claude/code-style-index.json")
```

The index contains all formatting rules: indentation, quotes, semicolons, trailing commas, bracket spacing, import ordering, empty-line patterns, JSX formatting, and per-package overrides.

**If the index exists** (it should): apply all rules directly — skip to Step 2.

**If the index does NOT exist**: scan formatter configs (`.prettierrc`, `.editorconfig`, `eslint.config.*`) and 10-20 representative source files. Then create the index at `$CLAUDE_PROJECT_DIR/.claude/code-style-index.json` using the structure documented in the code-style skill's original template.

## Step 2: Apply Exactly

1. Match every observed convention — no exceptions, no personal defaults
2. Never "improve" formatting — if the project uses tabs, use tabs
3. Match empty line patterns, comment style, import ordering exactly
4. When creating new files, match sibling files of the same type

## Step 3: Update the Index

If you observe a style pattern **not yet recorded** in the index:

1. Read the current index
2. Add the new pattern
3. Write it back

Never remove existing entries unless factually wrong.
