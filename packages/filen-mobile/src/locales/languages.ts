// Single source of truth for the app's supported languages.
//
// This array drives EVERYTHING language-related: the i18next `resources`/`supportedLngs`,
// the `Language` type, iOS `CFBundleLocalizations`, and the Android locale-config plugin's
// locale list. Keep it as the only list — never hand-maintain a parallel list anywhere else.
//
// MUST stay import-free: `app.config.ts` loads this in a plain Node context (no `@/` alias,
// no React Native, no Expo). Adding any import here breaks the config build.
//
// `en` is the source language; the rest are filled by the CI translation pipeline
// (scripts/translate-i18n.ts). Adding a language is a one-line edit here plus a new
// `<lang>.json` stub catalog, a `LANGUAGE_LABELS` entry, and a `resources` import in i18n.ts.
export const SUPPORTED_LANGUAGES = [
	"en",
	"de",
	"es",
	"fr",
	"it",
	"pt",
	"ru",
	"ja",
	"zh",
	"bn",
	"cs",
	"da",
	"fi",
	"hi",
	"hu",
	"id",
	"ko",
	"nl",
	"no",
	"pl",
	"ro",
	"sv",
	"th",
	"tr",
	"uk",
	"vi"
] as const
