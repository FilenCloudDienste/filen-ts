---
description: Fan out the review subagents across a codebase as a dynamic workflow — parallel read-only audit, an Opus cross-check, and a gated behavior-preserving refactor.
argument-hint: [paths/globs — defaults to files changed vs main]
model: opus
---

Build and run a **dynamic workflow** that reviews the code at **$ARGUMENTS** using the two review subagents defined in `.claude/agents/`.

Scope rules:

- If `$ARGUMENTS` is empty, scope to the files changed versus the `main` branch (run `git diff --name-only main...HEAD`). Do **not** fan out across the whole repository unless `$ARGUMENTS` explicitly contains a repo-wide glob such as `src/**`.

The plan below is the orchestration. Adapt agent **counts** to the actual file count, but keep the **phase structure, the model routing, and the cost guardrails exactly as written** — they exist to keep this fleet under the weekly Opus limit.

## Workers — use these subagent definitions; do not improvise new ones

- **Phase 1 audit** → the `code-auditor` and `react-ts-refactor` subagents
- **Phase 2 verification + consolidation** → subagents that fact and do adversarial reviews of the phase 1 results

Each subagent's own `tools` allowlist still applies inside the workflow, so the two auditors physically cannot edit files even though workflow agents run in `acceptEdits` mode. Rely on that — do not grant them edit access.

## Model routing

Default every agent to **Opus 4.8 at high effort**, then **downgrade per stage**:

- **`code-auditor` agents → Sonnet.** Breadth across many files; cheap per file.
- **`react-ts-refactor` agents → Sonnet.** Breadth across many files; cheap per file.
- **Phase 2 verification + consolidation → Opus.** This is the only stage where Opus earns its cost; keep the agent count small.
