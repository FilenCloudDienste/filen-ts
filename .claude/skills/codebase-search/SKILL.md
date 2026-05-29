---
name: codebase-search
description: >
    CRITICAL! Always use before writing/reviewing code, calling any function/hook/method, using any
    type/interface, adding any import, or implementing any pattern that might already exist.
    Default posture: search first, then write. Never invent paths, names, or APIs.
---

# Codebase Search — Search First, Then Write

## When to Search

Search before proceeding if:

- You're about to call a function, method, or hook you haven't read
- You're about to use a type or interface you haven't seen defined
- You need an import path you're not certain about
- You're implementing something that likely has existing related code
- You're adding to a pattern (new route, event, component) and want to match existing ones
- You're unsure whether something already exists

## Search Toolkit — Use in Priority Order

Prefer the most precise tool first. Symbol-aware tools resolve through re-exports, barrel files, path aliases, and renames — text search can't. Fall back to text search only when symbol-aware tools can't answer the question (string literals, comments, config values, `tbd_` i18n keys, etc.).

### 1. LSP — symbol navigation (highest priority for code)

If an LSP server is available for the file's language, use the `LSP` tool for any symbol-related question:

| Question                                | LSP operation                       |
| --------------------------------------- | ----------------------------------- |
| Where is X defined?                     | `goToDefinition`                    |
| Where is X used? / Who calls X?         | `findReferences`, `incomingCalls`   |
| What does X call?                       | `outgoingCalls`                     |
| What is the type / signature of X?      | `hover` (no need to open the file)  |
| List all symbols in this file           | `documentSymbol`                    |
| Find a symbol by name across workspace  | `workspaceSymbol`                   |
| Find concrete implementations of X      | `goToImplementation`                |

After writing or editing code, also use LSP to check diagnostics on the changed file before moving on. Don't ignore type errors or missing imports.

### 2. Filesystem — Grep / Glob / Read

Use `Grep`/`Glob`/`Read` for everything LSP can't answer, and as the primary tool for text:
- Searching string literals, comments, config values, or `tbd_` i18n keys that LSP doesn't index
- Finding files by name (`Glob`) or browsing likely directories
- Reading a file when you already know the path (use `Read` directly with `offset`/`limit` for large files)

If the project's hooks block bare `grep`/`find`, prefer the `Grep`/`Glob` tools. Only fall back to the absolute path (`/usr/bin/grep`) when the tools are unavailable.

### 3. Agent (Explore subagent) — broad/open-ended exploration

Use an `Explore` subagent (with `thoroughness: "very thorough"`) when:
- Simple Grep/Glob hasn't found it after 3 different patterns
- You need to understand how a feature works across many files
- You're looking for architectural patterns rather than specific symbols
- The thing might be named very differently than expected

### Examples

```
# Jump to a function's definition (LSP)
LSP(operation: "goToDefinition", filePath: ".../foo.ts", line: 42, character: 10)

# Find all call sites before renaming a function (LSP)
LSP(operation: "findReferences", filePath: ".../auth.ts", line: 88, character: 14)

# Find a definition by text when LSP can't resolve it
Grep(pattern: "export.*useNotesWithContentQuery", glob: "packages/filen-mobile/src/**/*.{ts,tsx}", output_mode: "content")

# Find files by name
Glob(pattern: "**/*noteContent*")

# Search a string literal or i18n key (text fallback)
Grep(pattern: "tbd_delete_note", glob: "src/**/*.{ts,tsx}", output_mode: "content")
```

## Search Depth

**First search not finding it does NOT mean it doesn't exist.** Things hide behind
re-exports, barrel files, aliases, wrapper functions, different naming conventions,
or in unexpected directories. Always try multiple search strategies before concluding
something doesn't exist.

| Situation                                  | Minimum searches                                |
| ------------------------------------------ | ----------------------------------------------- |
| Using a function already read this session | 0                                               |
| Using a type/function not yet read         | 2-3 searches with different patterns            |
| Implementing a new feature                 | 5-8 searches across patterns, names, and dirs   |
| Refactoring existing behavior              | Read all affected files + search for usages     |
| "I don't think this exists"                | 3+ searches with varied terms before concluding |

### Search Strategies (try in order)

For symbol questions, exhaust LSP first (`goToDefinition`, `workspaceSymbol`, `findReferences`) before falling back to text search. The strategies below apply when text search is the right tool:

1. **Exact name** — `Grep(pattern: "useFoo")` — direct match
2. **Partial/fuzzy** — `Grep(pattern: "foo|Foo")` — catch different casings/prefixes
3. **Semantic variants** — search for synonyms and related terms (e.g., `format|render|display`, `cache|store|persist`, `delete|remove|destroy`)
4. **File name** — `Glob(pattern: "**/*foo*")` — maybe it's a whole file
5. **Directory scan** — `Glob(pattern: "src/lib/**/*.ts")` — browse likely directories
6. **Re-exports** — `Grep(pattern: "export.*from", path: "src/index.ts")` — check barrel files
7. **Usage search** — `Grep(pattern: "useFoo|\.foo\(")` — find how others consume it
8. **Cross-package** — search in other packages (`packages/*/src/`) — monorepo code sharing

## Rules

- For symbols: LSP first (`goToDefinition` / `findReferences` / `workspaceSymbol`), text search only when LSP can't help
- When LSP is unavailable for a language, fall back to `Grep`/`Glob`/`Read` text search
- Read the actual definition before using a symbol — don't reconstruct from context
- Find 1–2 real usages before writing your own
- Check the actual export list before importing
- Read the file you're editing top to bottom before changing it
- For third-party APIs, check `node_modules` if needed
- After writing or editing, check LSP diagnostics on the changed file before moving on
- Never invent a function signature because it "seems right"
- Never assume an import path without verifying
- **Never conclude "it doesn't exist" after a single search** — try at least 3 different patterns, ideally across LSP and text search
- **Search across all packages** — this is a monorepo, code may live in a sibling package
