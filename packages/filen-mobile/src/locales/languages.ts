// The app's supported languages: a literal copy of SUPPORTED_LANGUAGES in @filen/shared/languages,
// the list every Filen app shares (src/tests/i18n.test.ts keeps the two equal).
//
// This array drives EVERYTHING language-related in the app: the i18next catalogs/`supportedLngs`,
// the `Language` type, iOS `CFBundleLocalizations`, and the Android locale-config plugin's
// locale list, so changing it needs a native release.
//
// MUST stay import-free: `app.config.ts` loads this in a plain Node context (no `@/` alias,
// no React Native, no Expo) through ts-node in CommonJS, which cannot load the shared ESM
// package. Adding any import here breaks the config build.
//
// `en` is the source language; the rest are filled by the CI translation pipeline
// (scripts/translate-i18n.ts). Adding a language is an edit to the shared list and here, plus a
// new `<lang>.json` stub catalog and a loader entry in locales/catalogs.ts.
export const SUPPORTED_LANGUAGES = [
	"en",
	"de",
	"es",
	"fr",
	"it",
	"pt-BR",
	"pt-PT",
	"ru",
	"ja",
	"zh",
	"zh-TW",
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
