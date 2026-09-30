import type { Language } from "@/lib/language"

// Target-language catalogs are plain JSON value maps, filled by the CI translation pipeline
// (scripts/translate-i18n.ts). They start out as empty `{}` stubs and i18next falls back to
// `en` for any missing key. Only `en` is type-checked (via the `typeof en` augmentation in
// src/i18next.d.ts); the others are untyped value maps keyed off the English key set.
//
// Inline requires, not static imports: Metro runs without inlineRequires, so a static import
// would evaluate every catalog on each boot (headless runs included) although a session only
// reads the active language and its fallbacks. require is synchronous and caches per module.
export const CATALOG_LOADERS: Record<Exclude<Language, "en">, () => Record<string, string>> = {
	de: () => require("@/locales/de.json") as Record<string, string>,
	es: () => require("@/locales/es.json") as Record<string, string>,
	fr: () => require("@/locales/fr.json") as Record<string, string>,
	it: () => require("@/locales/it.json") as Record<string, string>,
	"pt-BR": () => require("@/locales/pt-BR.json") as Record<string, string>,
	"pt-PT": () => require("@/locales/pt-PT.json") as Record<string, string>,
	ru: () => require("@/locales/ru.json") as Record<string, string>,
	ja: () => require("@/locales/ja.json") as Record<string, string>,
	zh: () => require("@/locales/zh.json") as Record<string, string>,
	"zh-TW": () => require("@/locales/zh-TW.json") as Record<string, string>,
	bn: () => require("@/locales/bn.json") as Record<string, string>,
	cs: () => require("@/locales/cs.json") as Record<string, string>,
	da: () => require("@/locales/da.json") as Record<string, string>,
	fi: () => require("@/locales/fi.json") as Record<string, string>,
	hi: () => require("@/locales/hi.json") as Record<string, string>,
	hu: () => require("@/locales/hu.json") as Record<string, string>,
	id: () => require("@/locales/id.json") as Record<string, string>,
	ko: () => require("@/locales/ko.json") as Record<string, string>,
	nl: () => require("@/locales/nl.json") as Record<string, string>,
	no: () => require("@/locales/no.json") as Record<string, string>,
	pl: () => require("@/locales/pl.json") as Record<string, string>,
	ro: () => require("@/locales/ro.json") as Record<string, string>,
	sv: () => require("@/locales/sv.json") as Record<string, string>,
	th: () => require("@/locales/th.json") as Record<string, string>,
	tr: () => require("@/locales/tr.json") as Record<string, string>,
	uk: () => require("@/locales/uk.json") as Record<string, string>,
	vi: () => require("@/locales/vi.json") as Record<string, string>
}
