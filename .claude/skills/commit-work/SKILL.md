---
name: commit-work
description: >
    Create high-quality git commits: review/stage intended changes, split into logical commits,
    and write clear Conventional Commit messages. Use when asked to commit, craft a commit
    message, stage changes, or split work into multiple commits.
---

# Commit Work

## Goal

Make commits that are easy to review and safe to ship: only intended changes are included, commits are logically scoped, messages describe what changed and why.

## Workflow

1. **Inspect** the working tree before staging
    - `git status`, `git diff`, `git diff --stat` for many changes
2. **Decide commit boundaries** (split if needed)
    - Split by: feature vs refactor, backend vs frontend, formatting vs logic, tests vs prod code, dependency bumps vs behavior changes
3. **Stage** only what belongs in the next commit
    - Prefer `git add -p` for mixed changes
4. **Review** what will be committed
    - `git diff --cached`
    - No secrets, no debug logging, no unrelated churn
5. **Describe** the staged change in 1-2 sentences (what + why)
    - If you can't describe it cleanly, the commit is too big — go back to step 2
6. **Write** the commit message
    - Conventional Commits (required): `type(scope): short summary`
    - Body: what/why, not implementation diary
    - Use `references/commit-message-template.md` if helpful
7. **Verify** — use the verify-changes skill to run lint/typecheck/tests
8. **Repeat** for the next commit until the working tree is clean
9. **Never** add co-author attribution
