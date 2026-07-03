# Automated bug-hunt bot

A daily GitHub Actions job that runs headless Claude Code to hunt **one** real bug in a package, fix it
with a regression test, and open **one** PR for human review — or exit cleanly with no PR. Designed to
report nothing rather than noise.

Full design + threat model: `docs/superpowers/specs/2026-07-03-automated-bug-hunt-design.md` (gitignored).

## Files

| File | Role |
| --- | --- |
| `.github/workflows/bug-hunt-filen-mobile.yml` | The workflow: deterministic setup + one `claude -p` brain. |
| `.github/bug-hunt/filen-mobile.prompt.md` | Self-contained orchestrator prompt (the pipeline + guardrails). |
| `.github/bug-hunt/claude-settings.json` | Bot Claude Code settings: deny rules + sandbox + `disableBypassPermissionsMode`. |
| `.github/bug-hunt/README.md` | This file. |

## One-time setup (required — the bot cannot do these itself)

1. **Secret `ANTHROPIC_API_KEY`** — add it as a repo (or org) Actions secret. **Use a dedicated,
   spend-capped key** for the bot so any leak/abuse is capped and rotatable in isolation. This is the one
   credential with lasting value; everything else on the runner is ephemeral or public.
2. **Create the labels** (the least-privilege token lacks `issues: write`, so it cannot create them):
   - `bot:bug-hunt` — applied by the bot to every PR it opens.
   - `rejected`, `wontfix`, `expected` — applied by **maintainers** when closing a bot PR (the learning loop).
3. **Protect `main`** — enable branch protection (no direct pushes; PR + review required). The token has
   `contents: write`; branch protection is what stops it being turned against `main`.
4. **Allow Actions to open PRs** — **Settings → Actions → General → Workflow permissions →** enable
   **"Allow GitHub Actions to create and approve pull requests"** (OFF by default). Without it,
   `gh pr create` fails with *"GitHub Actions is not permitted to create or approve pull requests"* and the
   bot produces **no PR every run** — the whole point. If the checkbox is greyed out, enable it at the
   **org** level first (FilenCloudDienste → Settings → Actions → General), then at the repo.

## How it runs

- **Manual** (`workflow_dispatch`, optional `max_areas` input = K) for now; the **daily cron is commented
  out** in the workflow for the testing phase — uncomment the two `schedule:` lines to activate it.
- **Skip gate:** if a `bot:bug-hunt` PR is already open, the run exits immediately (no model tokens spent)
  so reviewers are never flooded. Only one open bot PR at a time.
- Runs on `ubuntu-latest` (verify is Node-only; no macOS/native build needed).

## The learning loop (how to teach it)

When the bot opens a PR, either:
- **Merge it** (accepted) — the fix lands; that bug self-excludes.
- **Close it with a label** — `rejected` (not a real bug), `wontfix` (real but leave it), or `expected`
  (intended behavior). Optionally **leave a comment explaining why.**

On the next run the bot reads its closed PRs and won't re-report that **class** of finding. Only comments
from **trusted authors** (repo `OWNER`/`MEMBER`/`COLLABORATOR`) are ingested — arbitrary public comments
are dropped in the workflow before the agent ever sees them (prompt-injection defense).

## Security posture (short)

The agent runs in classifier-gated **auto mode** (not `--dangerously-skip-permissions`). Defense is
layered and assumes the agent *can* be prompt-injected:
- **Secret-starved env** (primary): only `ANTHROPIC_API_KEY` + the ephemeral `GITHUB_TOKEN` are mapped;
  signing/publishing secrets are never referenced, so they're absent from the runner.
- **Least-privilege token:** `contents: write` + `pull-requests: write`, nothing else.
- **Irrevocable deny rules** (curl/wget/nc, destructive git, edits to `.github`/`.claude`/submodules/locale
  JSONs) + **OS sandbox** (filesystem/network isolation; can mask `ANTHROPIC_API_KEY` from Bash).
- **Trusted-authors-only** learning-loop input; works only from reviewed `main`.

Worst realistic case, given the above: Anthropic-key abuse (→ dedicated spend-capped key) or wasted
tokens until timeout. See the spec for the full analysis.

## Verify on first run / tighten later

These are intentionally conservative for bring-up — confirm, then harden:

- [ ] **Pin the CLI version:** change `npm i -g @anthropic-ai/claude-code` to a pinned
      `@anthropic-ai/claude-code@<version>` ≥ **2.1.199** (auto mode 2.1.83+, spawn-time subagent eval
      2.1.178+, sandbox credential masking 2.1.199+).
- [ ] **1M context:** confirm the exact mechanism for the pinned CLI. The workflow sets
      `ANTHROPIC_BETAS=context-1m-2025-08-07` as a best guess — verify it's correct/needed.
- [ ] **Sandbox (security-relevant — the masking ships INERT):** the shipped config is bring-up-permissive
      (`"failIfUnavailable": false`, `"allowUnsandboxedCommands": true`), so the `ANTHROPIC_API_KEY` mask and
      the network egress allowlist do **not** bind — until you flip it, the key is protected ONLY by
      secret-starving + the dedicated spend-capped key (an injected agent could still reach `node -e`/
      `/dev/tcp` egress). Once `bubblewrap` is confirmed on the runner, flip `claude-settings.json` to strict
      (`"failIfUnavailable": true` + `"allowUnsandboxedCommands": false`) so the mask + allowlist actually bind.
- [ ] **Deny syntax:** confirm the `Bash(curl *)` deny actually blocks a piped `echo x | curl …` (the
      settings list both `Bash(curl *)` and `Bash(curl:*)` forms defensively — over-denying is safe).
- [ ] **Model tiering (cost):** the whole run is Opus today. To run the cheap map/rank/select stages on
      Sonnet, add `.claude/agents/*.md` subagent definitions with `model: claude-sonnet-5` frontmatter and
      have the orchestrator delegate those stages to them.
- [ ] **Checkout weight:** the workflow does a recursive full-depth submodule checkout by request; verify
      doesn't need it. Swap to a plain `actions/checkout@v5` for a much faster, lighter run if preferred.

## Cost bounds

`--max-turns 300` + `timeout-minutes: 90` + `K` areas (default 3, first verified bug wins) + the open-PR
skip gate bound each run. Tune after observing real runs.

## Adding another package

Copy the workflow to `bug-hunt-<package>.yml`, point it at that package's dir + `verify` command, add a
`<package>.prompt.md` (or parameterize the shared prompt), and supply that package's verify env if any.
The orchestrator prompt self-discovers product context, so most of it is reusable.
