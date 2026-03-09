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

## Search Toolkit

| Task                         | Tool                         |
| ---------------------------- | ---------------------------- |
| Search file contents         | **Grep**                     |
| Find files by name           | **Glob**                     |
| Read a specific file         | **Read**                     |
| Broad multi-file exploration | **Agent** (Explore subagent) |

### Examples

```
# Find a function definition
Grep(pattern: "export.*function useFoo|export const useFoo", glob: "src/**/*.{ts,tsx}", output_mode: "content")

# Find a type definition
Grep(pattern: "interface FooProps|type FooProps", glob: "src/**/*.{ts,tsx}", output_mode: "content")

# Check exports before importing
Grep(pattern: "^export", path: "./src/utils/index.ts", output_mode: "content")

# Find files by name
Glob(pattern: "**/*auth*", path: "./src")

# Check if something already exists
Grep(pattern: "formatDate|format_date", glob: "src/**/*.{ts,tsx}", output_mode: "files_with_matches")
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

1. **Exact name** — `Grep(pattern: "useFoo")` — direct match
2. **Partial/fuzzy** — `Grep(pattern: "foo|Foo")` — catch different casings/prefixes
3. **Semantic variants** — search for synonyms and related terms (e.g., `format|render|display`, `cache|store|persist`, `delete|remove|destroy`)
4. **File name** — `Glob(pattern: "**/*foo*")` — maybe it's a whole file
5. **Directory scan** — `Glob(pattern: "src/lib/**/*.ts")` — browse likely directories
6. **Re-exports** — `Grep(pattern: "export.*from", path: "src/index.ts")` — check barrel files
7. **Usage search** — `Grep(pattern: "useFoo|\.foo\(")` — find how others consume it
8. **Cross-package** — search in other packages (`packages/*/src/`) — monorepo code sharing

### When to Use the Explore Agent

Use an Explore subagent (with `subagent_type: "Explore"` and thoroughness `"very thorough"`) when:

- Simple Grep/Glob hasn't found what you need after 3 tries
- You need to understand how a feature works across multiple files
- You're looking for architectural patterns rather than specific symbols
- The thing you're looking for might be named very differently than expected

## Rules

- Grep for the symbol, read the definition, then use it
- Find 1-2 real usages before writing your own
- Check the actual export list before importing
- Read the file you're editing top to bottom before changing it
- For third-party APIs, check `node_modules` if needed
- Never invent a function signature because it "seems right"
- Never assume an import path without verifying
- Never reconstruct a type from context instead of reading its definition
- **Never conclude "it doesn't exist" after a single search** — try at least 3 different patterns
- **Search across all packages** — this is a monorepo, code may live in a sibling package
