---
name: commit-work
description: >
    Commit conventions for this repo: Conventional Commits scopes, splitting and staging without
    interactive git, pre-commit checks and message rules. Use when asked to commit, craft a commit
    message, stage changes, or split work into multiple commits.
---

# Commit Work

- **Conventional Commits** `type(scope): summary`. Scopes in use: `mobile`, `web`, `shared`, `deps`, `ci`; a bare type (`refactor: …`) for cross-package changes.
- Commit directly on `main`; no branches or PRs unless asked.
- Split by logical change (feature vs refactor, behaviour vs formatting, dependency bump vs code). Each commit leaves the package green.
- Stage by path (`git add <paths>`). For hunk-level splits, write the wanted hunks to a patch and `git apply --cached <patch>`; never `git add -p` or `-i` (interactive git is unsupported here).
- Review `git diff --cached` before committing: nothing unrelated, no secrets, no debug logging.
- Run the touched package's `pnpm run lint`, `pnpm run typecheck` and `pnpm test` first (see root CLAUDE.md for per-package differences).
- Message: terse imperative subject; the body states what changed and the non-obvious why, once. The repo is public: no names, plan ids or dates.
- Never add `Co-Authored-By`, `Claude-Session` or any other AI/Claude attribution, in any commit, including squash and merge commits.
