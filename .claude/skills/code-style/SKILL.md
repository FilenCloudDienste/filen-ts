---
name: code-style
description: >
    Use before writing or modifying code. Reads the style index at
    $CLAUDE_PROJECT_DIR/.claude/code-style-index.json for the project's exact style rules.
    Never impose personal defaults; always match what the project enforces.
---

# Code Style Matching

Before writing or modifying code, match the project's exact code style.

## Step 1: Load the Style Index

```
Read(file_path: "$CLAUDE_PROJECT_DIR/.claude/code-style-index.json")
```

The index contains all formatting rules: indentation, quotes, semicolons, trailing commas, bracket spacing, import ordering, empty-line patterns, JSX formatting, and per-package overrides.

If the index is missing, read the formatter configs (`.prettierrc`, `.editorconfig`, `eslint.config.*`) and a few sibling files instead.

## Step 2: Apply Exactly

1. Match every observed convention — no exceptions, no personal defaults
2. Never "improve" formatting — if the project uses tabs, use tabs
3. Match empty line patterns, comment style, import ordering exactly
4. When creating new files, match sibling files of the same type
