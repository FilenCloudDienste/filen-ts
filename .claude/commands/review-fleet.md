<!--
  /review-fleet — operator notes (the team reads this; Claude ignores HTML comments)

  Runs the three subagents in .claude/agents/ as a dynamic workflow:
    code-auditor + dead-code-auditor (read-only) -> Opus cross-check -> gated react-ts-refactor.

  This fleet runs on Opus 4.8. The binding constraint is the WEEKLY Opus cap (the recent
  5-hour-window increase did not change it), so the plan below routes cheap stages to Haiku/Sonnet
  and reserves Opus for verification and the actual refactor.

  Recommended two-step usage (sign-off between stages):
    1. /review-fleet src/features/billing            # report-only, safe, parallel
    2. (review the report) then:
       /review-fleet src/features/billing apply       # runs the gated, behavior-preserving refactor

  Before a large run:
    - Pre-allowlist the commands the agents need so the run doesn't stall mid-flight on prompts:
      your typecheck / lint / test commands, plus knip|ts-prune|depcheck and git (see /permissions).
    - Check /model. Keep effort at high (default); do NOT use xhigh/max/ultracode for this fleet —
      it multiplies the Opus burn against the weekly cap.
    - Hard cost ceiling if you want one: export CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6 forces
      EVERY agent to Sonnet and overrides the per-stage routing below.
    - Watch spend live in /workflows (per-agent token totals); press p to pause, x to stop.
    - Requires a plan with Opus access (Pro is Sonnet-only) and Claude Code v2.1.154+.
-->

---

description: Fan out the review subagents across a codebase as a dynamic workflow — parallel read-only audit + dead-code sweep, an Opus cross-check, and a gated behavior-preserving refactor. Opus-budget aware.
argument-hint: [paths/globs — defaults to files changed vs main] [add the word "apply" to run the gated refactor]
model: opus

---

Build and run a **dynamic workflow** that reviews the code at **$ARGUMENTS** using the three review subagents defined in `.claude/agents/`.

Scope rules:

- If `$ARGUMENTS` is empty, scope to the files changed versus the `main` branch (run `git diff --name-only main...HEAD`). Do **not** fan out across the whole repository unless `$ARGUMENTS` explicitly contains a repo-wide glob such as `src/**`.
- If the word `apply` appears anywhere in `$ARGUMENTS`, run Phase 3 (the gated refactor). Otherwise **stop after Phase 2 and report only** — make no edits.

The plan below is the orchestration. Adapt agent **counts** to the actual file count, but keep the **phase structure, the model routing, and the cost guardrails exactly as written** — they exist to keep this fleet under the weekly Opus limit.

## Workers — use these subagent definitions; do not improvise new ones

- **Phase 1 audit** → the `code-auditor`, `react-ts-refactor` and `dead-code-auditor` subagents
- **Phase 2 verification + consolidation** → subagents that fact and do adversarial reviews of the phase 1 results

Each subagent's own `tools` allowlist still applies inside the workflow, so the two auditors physically cannot edit files even though workflow agents run in `acceptEdits` mode. Rely on that — do not grant them edit access.

## Model routing — the main lever for staying under the Opus cap

Default every agent to **Opus 4.8 at high effort**, then **downgrade per stage**:

- **`dead-code-auditor` agents → Sonnet.** The work is mechanical (run `knip`/`ts-prune`/`depcheck` if present, else grep); it does not need Opus reasoning.
- **`code-auditor` sweep agents → Sonnet.** Breadth across many files; cheap per file.
- **`react-ts-refactor` sweep agents → Sonnet.** Breadth across many files; cheap per file.
- **Phase 2 verification + consolidation → Opus.** This is the only stage where Opus earns its cost; keep the agent count small.

## Cost & concurrency guardrails (non-negotiable)

- Honor the runtime's 16-concurrent-agent cap, and additionally **cap concurrent Opus agents at 8** to smooth the burn against the weekly Opus bucket. Let the Haiku/Sonnet agents use the rest of the concurrency.

## Phase 1 — parallel read-only sweep (Sonnet)

Partition the in-scope files into independent groups by module/feature. For each group, spawn in parallel:

1. a `code-auditor` agent (Sonnet) that audits that group and returns findings as structured data: `{ file, line, category, symptom, triggerConditions, severity (P0|P1|P2), confidence (high|medium|low) }`;
2. a `dead-code-auditor` agent (Haiku) that returns deletion candidates: `{ path|symbol, artifactType, detectionMethod, confidence, checklistStatus }`.
   Keep every group's raw output in the workflow script's variables, not in the final context.

## Phase 2 — Opus cross-check and plan (Opus)

1. **Adversarial verification.** For each high-severity bug and every security finding, spawn an independent Opus verifier agent whose job is to _try to refute the finding_ — locate an existing guard, sanitizer, server-side control, or surrounding code that already handles it. **Drop findings that don't survive**; keep the rest with the refuter's notes attached. This is what makes the report trustworthy rather than a single pass.
2. **Consolidate**: dedupe across groups, merge overlapping findings, and rank by severity then confidence.
3. **Emit a refactor plan**: from the surviving findings, list only the items the `react-ts-refactor` agent could fix _while preserving behavior_ (its safe catalog — not bugs, security, behavior-changing perf, or deletions). Partition that plan into **independent units that touch disjoint files**, so Phase 3 can parallelize without two agents editing the same file.
4. If `apply` was not requested, **stop here** and produce the report below.

## Output

Return one consolidated report:

- **Verified findings**, grouped by category, ranked by severity then confidence, each with file/line, trigger conditions, and (for security) the refuter's notes on in-codebase mitigations.
- **Dead-code candidates** as a separate table (these always need human confirmation before deletion).
- **Refactor plan** — the partitioned behavior-preserving units, marked applied vs not-applied.
- If `apply` ran: a **diff summary** per unit and the safety-net status (characterization tests written and passing).
- A short **cost summary** (total agents by model, total tokens) so the spend is visible.

If you did not run `apply`, end by printing the exact command to apply the plan on this scope, e.g. `/review-fleet <scope> apply`.
