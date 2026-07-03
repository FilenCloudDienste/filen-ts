<!-- Keep the summary short and concrete: what changed and why it was needed. -->

## Summary



Fixes #<!-- issue number, if any -->

## Packages touched

<!-- Check everything the diff touches. -->

- [ ] filen-mobile
- [ ] filen-web
- [ ] filen-desktop
- [ ] filen-utils
- [ ] CI / workflows
- [ ] Repo tooling / docs

## Kind of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor (no behavior change)
- [ ] Dependency bump
- [ ] CI / build
- [ ] Docs

## How it was tested

<!-- Be specific: commands run, platforms used. "npm run verify" = lint + typecheck + tests, per package. -->

- [ ] `npm run verify` is green in every touched package
- [ ] filen-mobile, native-affecting changes only: fresh `expo prebuild` + ran on iOS
- [ ] filen-mobile, native-affecting changes only: fresh `expo prebuild` + ran on Android



## Notes for reviewers

<!-- Breaking changes, migration steps, risky spots, follow-ups deliberately left out. Delete if none. -->

## Checklist

- [ ] New user-facing strings (mobile) live only in `src/locales/en/*.ts` - the translated `<lang>.json` catalogs and `.en-snapshot.json` are CI-managed and untouched
- [ ] Dependency bumps: `patches/` still apply cleanly (patch-package filenames match the installed versions)
- [ ] No secrets, tokens, or account data in code, fixtures, or test data
