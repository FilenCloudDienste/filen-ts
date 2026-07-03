# Issue-fix bot

Fires when a maintainer labels an issue **`bot:fix`**. Runs headless Claude Code to fix the reported bug and
open **one** PR (`Fixes #N`) — but only when it's confident and `npm run verify` is green, with an honest
"needs manual QA" note for GUI/device behavior it can't verify headless. Thin report → `bot:fix:needs-info`;
can't reliably fix → `bot:fix:tried`. Always comments its investigation on the issue.

Sibling to the **bug-hunt bot** — shares the same substrate (`.github/bot/claude-settings.json`, gateway model,
auto mode, sandbox, `disableWorkflows`). Full design + threat model:
`docs/superpowers/specs/2026-07-03-issue-fix-bot-design.md` (gitignored).

## Files

| File | Role |
| --- | --- |
| `.github/workflows/issue-fix-filen-mobile.yml` | The workflow: label gate → cheap completeness pre-check → one `claude -p` brain. |
| `.github/issue-fix/filen-mobile.prompt.md` | Self-contained orchestrator prompt (triage → fix → verify → PR/punt, tiered). |
| `.github/bot/claude-settings.json` | **Shared** Claude settings (with the bug-hunt bot). |
| `.github/issue-fix/README.md` | This file. |

## One-time setup

Most is shared with the bug-hunt bot (see `.github/bug-hunt/README.md`) — the gateway secrets
(`CC_ANTHROPIC_*`), the "Allow GitHub Actions to create and approve pull requests" toggle, and branch
protection on `main`. Additionally:

- **Labels** (maintainer-applied unless noted): `bot:fix` (you apply it to trigger + the bot applies it to its
  PR), `bot:fix:needs-info`, `bot:fix:tried` (bot-applied).
- **Enable "Automatically delete head branches"** (Settings → General → Pull Requests) so merged PR branches are
  cleaned up. Closed-unmerged ones are pruned by the `bot-branch-janitor` workflow.
- Nothing else — `issues: write` (needed to label/comment the issue) is declared in the workflow, not a repo
  setting.

## How it works

1. You label an issue **`bot:fix`** (only maintainers can — a random reporter can't self-trigger).
2. **Cheap pre-check (bash, no model tokens):** dedupe (skip if an open PR already fixes it) + "was the bug
   template used?" (a freeform issue → `bot:fix:needs-info` + comment, no agent run).
3. The agent triages → diagnoses (static analysis) → fixes → verifies what it can → adversarially challenges its
   own diagnosis → produces one of:
   - **PR** (`Fixes #N`), **Tier 1** (regression-test-proven, empty QA section) or **Tier 2** (static
     high-confidence, with a **"⚠️ needs manual QA"** checklist — the common case for GUI bugs).
   - **`bot:fix:needs-info`** — report too thin; comment says exactly what to add.
   - **`bot:fix:tried`** — real report, couldn't fix/verify with confidence; comment gives the trace + a
     best-effort diff as a suggestion.
4. It **always comments** its investigation and **removes `bot:fix`** when done.

**Retry loop:** the bot removes `bot:fix` on every run. Re-apply it to retry — after adding info (for
`needs-info`), or bare (mainly useful for `tried` — another attempt). Re-applying clears the prior outcome label.

## Confidence tiers (why some PRs need manual QA)

filen is a GUI app; most bugs can't be reproduced in headless CI. So the bot ships on **tiered confidence** with
`npm run verify` green as the floor in every tier:
- **Tier 1** — the logic was unit-testable → a regression test proves the fix. Merge with confidence.
- **Tier 2** — the root cause is clearly traced in code + verifiers endorse it, but the *behavior* needs a
  device/browser to confirm → the PR ships with exact manual-QA steps. **Run them before merging.**
- Otherwise it doesn't open a PR — it labels `bot:fix:tried` and hands you a head-start.

## Security

Inherits every bug-hunt control (secret-starve, least-privilege token, sandbox, deny rules, classifier auto
mode, `disableWorkflows`). Deltas: the **issue body/title are attacker-authored** and are treated as delimited
untrusted *data* (never instructions), and the token additionally carries **`issues: write`** (to label/comment
the issue — moderate on a public repo; not code/secrets). The `bot:fix` trigger is maintainer-only.

## Coexistence with the bug-hunt bot

- **Distinct PR label:** issue-fix PRs use `bot:fix`, NOT `bot:bug-hunt` — so they never trip the bug-hunt skip
  gate. The two queues are independent (no shared concurrency lock; no shared mutable state).
- **Shared settings:** `.github/bot/claude-settings.json` is the single source of truth for both bots.
- **`bot/` branch prefix:** both branch under `bot/…` so the `bot-branch-janitor` prunes them.

## Verify on first run / tighten later

Same shared checklist as the bug-hunt bot (see its README): pin the CLI version, confirm the 1M-context
mechanism, and note the sandbox is **inert on GitHub-hosted runners** (bubblewrap's network namespace fails there)
— keep it permissive; do NOT flip it strict, it breaks every Bash command. Also confirm the completeness pre-check
matches the current bug-report template's "Steps to reproduce" section heading.
