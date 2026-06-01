// Single source of truth for the app's supported languages.
//
// This array drives EVERYTHING language-related: the i18next `resources`/`supportedLngs`,
// the `Language` type, iOS `CFBundleLocalizations`, and the Android locale-config plugin's
// locale list. Keep it as the only list — never hand-maintain a parallel list anywhere else.
//
// MUST stay import-free: `app.config.ts` loads this in a plain Node context (no `@/` alias,
// no React Native, no Expo). Adding any import here breaks the config build.
//
// Phase 1 value is `["en"]`. Adding a language is a one-line edit here plus a new catalog file.
export const SUPPORTED_LANGUAGES = ["en"] as const
