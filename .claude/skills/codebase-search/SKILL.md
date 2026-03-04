---
name: codebase-search
description: >
    CRITICAL! Always use before writing code, calling any function/hook/method, using any
    type/interface, adding any import, or implementing any pattern that might already exist.
    Searches the codebase (Grep, Glob, Read) to find real signatures, existing implementations,
    and canonical import paths — never assume or reconstruct from memory. Default posture:
    search first, then write. If in doubt whether something exists: search. Never invent
    plausible-sounding paths, names, or APIs that haven't been verified in the actual files.
---

# Codebase Search Skill

When working in any existing codebase, you must actively search for relevant context before writing or answering. Never rely on assumptions about how things are named, shaped, or wired together. This skill defines when and how to search.

---

## Rule: When in Doubt, Search

If any of the following are true, **run a search before proceeding**:

- You are about to call a function, method, or hook you haven't read
- You are about to use a type, interface, or schema you haven't seen defined
- You need to import something and aren't certain of its exact export name or path
- You are implementing a feature that likely has related existing code
- You are asked how something works but haven't read the relevant files
- You see a reference (variable, constant, config key) whose value you don't know
- You are adding to a pattern (e.g. a new route, a new event, a new component) and want to match existing ones
- You are unsure whether something already exists before creating it

**Default posture: search first, then write.** It is always cheaper to run a grep than to write code against a wrong assumption.

---

## Search Toolkit

Use Claude Code's **native tools** — never Bash for file searching or reading. The dedicated tools are faster, require no shell permission, and automatically exclude noise like `node_modules`.

| Task | Use | Never use |
| ---- | ---- | ---- |
| Search file contents by pattern | **Grep** tool | `grep` / `rg` in Bash |
| Find files by name/glob pattern | **Glob** tool | `find` / `ls` in Bash |
| Read a specific file | **Read** tool | `cat` / `head` / `tail` in Bash |
| Broad multi-file exploration | **Agent** (Explore subagent) | — |

### 1. Grep — search file contents by pattern

```
Grep(pattern: "export.*MyFunction", glob: "**/*.{ts,tsx}", output_mode: "content")
Grep(pattern: "MyFunction", glob: "**/*.{ts,tsx}", output_mode: "files_with_matches")
Grep(pattern: "^(export )?(type|interface) MyType", type: "ts", output_mode: "content")
Grep(pattern: "MY_CONSTANT|myConstant", output_mode: "files_with_matches")
Grep(pattern: "upload.*progress|progress.*upload", glob: "**/*.{ts,tsx}", -i: true, output_mode: "content")
```

The `glob` and `type` parameters scope the search. The Grep tool already excludes `.git`; use `glob: "src/**/*"` to avoid `dist/`, `node_modules/`, etc.

### 2. Glob — find files by name pattern

```
Glob(pattern: "**/*auth*", path: "./src")
Glob(pattern: "src/components/**/*.tsx")
Glob(pattern: "**/*.test.ts")
Glob(pattern: "src/**/*.ts")   // scoped — avoids dist/, node_modules/
```

Returns paths sorted by modification time. Use this when you know roughly what a file is called.

### 3. Read — read a specific file

```
Read(file_path: "/absolute/path/to/file.ts")
Read(file_path: "/absolute/path/to/large-file.ts", offset: 50, limit: 100)
```

Always use absolute paths. Read the whole file before editing — never just the target lines.

### 4. Agent (Explore subagent) — open-ended multi-file exploration

For searches that would require many rounds of Grep + Glob (you don't know what files to look in, or the concept spans many naming conventions), delegate:

```
Agent(subagent_type: "Explore", prompt: "Find all places where X pattern is used and how it works")
```

Use this when: you need to understand a system across many files, or a simple grep won't find everything because the naming is inconsistent.

---

## What to Search For

### Before using any function or hook

Search for its definition to understand the real signature, return type, and any quirks:

```
Grep(pattern: "export.*function useFoo|export const useFoo", glob: "**/*.{ts,tsx}", output_mode: "content")
```

### Before using any type or interface

Read the actual definition — don't reconstruct it from memory:

```
Grep(pattern: "interface FooProps|type FooProps", glob: "**/*.{ts,tsx}", output_mode: "content")
```

### Before adding a new instance of a pattern

Find existing instances to match the exact shape:

```
# e.g., before adding a new API route handler
Grep(pattern: "router\.(get|post|put|delete)", type: "ts", output_mode: "content", head_limit: 20)
```

### Before creating something that might already exist

Check first:

```
Grep(pattern: "formatDate|format_date", glob: "**/*.{ts,js}", output_mode: "files_with_matches")
```

### Before importing from a module

Verify the export exists and get the exact name:

```
Grep(pattern: "^export", path: "./src/utils/index.ts", output_mode: "content")
```

---

## Search Depth Guidelines

| Situation                                     | Searches needed                                          |
| --------------------------------------------- | -------------------------------------------------------- |
| Using one known, previously-read function     | 0 — already have context                                 |
| Using a function seen earlier in this session | 0 — already in context                                   |
| Using any type/function not yet read          | 1–2 targeted greps                                       |
| Implementing a new feature                    | 3–5 searches across related files                        |
| Refactoring or modifying existing behavior    | Read all directly affected files first                   |
| Answering "how does X work"                   | Read the relevant files, don't summarize from assumption |

---

## Anti-Patterns to Avoid

**Never do these:**

- ❌ Invent a function signature because it "seems right"
- ❌ Assume an import path without verifying it exists
- ❌ Reconstruct a type from context instead of reading its definition
- ❌ Assume a pattern is consistent without checking a real example
- ❌ Write code that calls into modules you haven't read
- ❌ Answer "does X exist?" without searching

**Always do these instead:**

- ✅ Grep for the symbol, read the definition, then use it
- ✅ Find one or two real usages before writing your own
- ✅ Check the actual export list before importing
- ✅ Read the file you're editing from top to bottom before changing it
- ✅ If a definition, type, function, variable etc. comes from a third party dependency, look it up in the dependency directory (e.g. node_modules)

---

## Efficient Search Habits

- **Combine searches**: run Grep for content and Glob for files in parallel when you need both
- **Read before editing**: always use Read on the full file you're about to modify — not just target lines
- **Follow imports**: if a file imports something unfamiliar, Grep for its definition before using it
- **Check barrel files**: many projects re-export from `index.ts` — Grep `"^export"` there first for the canonical import path
- **Scope searches**: use `glob: "src/**/*"` or `type: "ts"` to avoid noise from `dist/`, `node_modules/`, `.d.ts`

---

## Scoping Searches (avoid noise)

Use `glob` or `type` parameters to limit Grep to relevant files:

```
# Scoped to source TypeScript only — avoids dist/, node_modules/, .d.ts
Grep(pattern: "...", glob: "src/**/*.{ts,tsx}", output_mode: "content")

# By file type (auto-excludes common noise)
Grep(pattern: "...", type: "ts", output_mode: "files_with_matches")

# For Rust/Go/other projects — scope to source dir
Grep(pattern: "...", glob: "src/**/*.rs", output_mode: "content")
```

Glob patterns are already scoped by the path you provide — `Glob("src/**/*.ts")` never reaches `node_modules`.

---

## Reminder

Code that is written without reading the codebase first is a guess. Guesses break things. The codebase is always the source of truth — search it.
