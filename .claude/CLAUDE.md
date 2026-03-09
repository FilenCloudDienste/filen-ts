# Global Instructions

## Skill Check (mandatory)

Before starting ANY task, check available skills for relevance.

If there is even a 0.01% chance a skill applies, invoke it before doing anything else.

Never rationalize skipping a skill check with "this is simple enough" or "I already know how.".

## Code Intelligence

Prefer LSP over Grep/Glob/Read for code navigation:

- `goToDefinition` / `goToImplementation` to jump to source
- `findReferences` to see all usages across the codebase
- `workspaceSymbol` to find where something is defined
- `documentSymbol` to list all symbols in a file
- `hover` for type info without reading the file
- `incomingCalls` / `outgoingCalls` for call hierarchy

Before renaming or changing a function signature, use
`findReferences` to find all call sites first.

Use Grep/Glob only for text/pattern searches (comments,
strings, config values) where LSP doesn't help.

After writing or editing code, check LSP diagnostics before
moving on. Fix any type errors or missing imports immediately.

## Rust SDK (`@filen/sdk-rs`)

The Rust SDK is the backbone of all Filen apps. It handles everything below the UI layer — **never reimplement** what it already provides.

### What the SDK owns

- **Networking** — all API requests, WebSocket connections, rate limiting
- **Concurrency** — parallel uploads/downloads with configurable limits
- **Retries** — transient failure handling built into the Rust layer
- **Encryption** — all crypto in Rust, JS only sees decrypted types
- **Auth** — login, 2FA, sessions

### Rules

- **Never reimplement crypto or API calls in JS/TS** — always delegate to the SDK
- **Never add retry/rate-limit/concurrency logic in JS** — the SDK handles this internally

## Context Efficiency

### Subagent Discipline

**When to delegate:**

- Under ~50k context: prefer inline work for tasks under ~5 independent tool calls.
- Over ~50k context: prefer subagents for self-contained tasks, even simple ones — the per-call token tax on large contexts adds up fast.
- Sequential dependent chains (read → grep → read → edit → verify): delegate regardless of context size — they balloon context with intermediate results.

**Foreground vs background:**

- **Foreground** (default): use when you need the result before continuing — e.g. research that informs your next step.
- **Background** (`run_in_background: true`): use for independent work you don't need immediately — e.g. running tests while you edit another file. You'll be notified on completion; don't poll.

**Parallel agents:**

- Launch multiple independent subagents in a single message whenever possible — this is the biggest efficiency win.
- Example: searching for a type definition + checking existing usages + reading docs = 3 parallel agents, not 3 sequential ones.

**Output rules:**

- Always include in subagent prompts: "Final response under 2000 characters. List outcomes, not process."
- Exception: if the subagent needs to return code snippets or multi-file findings, allow flexible length but still require conciseness.

**TaskOutput for background agents:**

- Never call TaskOutput twice for the same subagent. If it times out, increase the timeout — don't re-read.

### File Reading

Read files with purpose. Before reading a file, know what you're looking for.
Use Grep to locate relevant sections before reading entire large files.
Never re-read a file you've already read in this session.
For files over 500 lines, use offset/limit to read only the relevant section.

### Responses

Don't echo back file contents you just read — the user can see them.
Don't narrate tool calls ("Let me read the file..." / "Now I'll edit..."). Just do it.
Keep explanations proportional to complexity. Simple changes need one sentence, not three paragraphs.

**Tables — STRICT RULES (apply everywhere, always):**

- Markdown tables: use minimum separator (`|-|-|`). Never pad with repeated hyphens (`|---|---|`).
- NEVER use box-drawing / ASCII-art tables with characters like `┌`, `┬`, `─`, `│`, `└`, `┘`, `├`, `┤`, `┼`. These are completely banned.
- No exceptions. Not for "clarity", not for alignment, not for terminal output.
