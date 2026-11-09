import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import { EN_CATALOGS, type EnNamespace } from "@/lib/i18n/catalog"

// Per-namespace key unions, derived from the same object that is registered as i18next's `resources`
// below, so a union can never name a key the app does not actually ship. `Extract<..., string>`
// (not `keyof … & string` — flagged as a redundant intersection by
// @typescript-eslint/no-redundant-type-constituents for these literal-keyed objects; identical
// resulting type, matches the `Extract<>` idiom already used in @/stores/boot.ts) guards the same
// way against a future non-string key.
//
// The keymap's `ActionDef.descriptionKey` composes these into namespace-PREFIXED literals
// (`ShortcutDescriptionKey`, lib/keymap/registry.ts) — a bare key would only ever resolve in
// whichever namespace `t` happened to default to.
export type NamespaceKey<N extends EnNamespace> = Extract<keyof (typeof EN_CATALOGS)[N], string>

export type CommonKey = NamespaceKey<"common">

export type DriveKey = NamespaceKey<"drive">

export type ContactsKey = NamespaceKey<"contacts">

export type PreviewKey = NamespaceKey<"preview">

export type NotesKey = NamespaceKey<"notes">

export type ChatsKey = NamespaceKey<"chats">

export type SettingsKey = NamespaceKey<"settings">

export type AudioKey = NamespaceKey<"audio">

export type PhotosKey = NamespaceKey<"photos">

export type VideosKey = NamespaceKey<"videos">

export type ArchiveKey = NamespaceKey<"archive">

export type EventsKey = NamespaceKey<"events">

export type AssistantKey = NamespaceKey<"assistant">

export type SyncKey = NamespaceKey<"sync">

export type MountsKey = NamespaceKey<"mounts">

// `Intl.PluralRules` gate: i18next's plural-key resolution (`_one`/
// `_other` suffixes, unused by rev 1's catalogs but load-bearing the moment a count-based key
// lands) needs it. Unlike React Native/Hermes — which mobile polyfills via `intl-pluralrules` —
// every browser capable of `self.crossOriginIsolated` (this app's hard boot floor, gated in
// @/workers/sdk.worker's pre-flight) ships `Intl.PluralRules` natively. No polyfill import here,
// by design.
//
// `resources`/`react.useSuspense`: English is the only bundled language and is registered here, synchronously, so
// module-level `i18n.t` callers and the first render always resolve. Every other language is a static JSON file
// that @/lib/i18n/language fetches and registers before it switches the language (startLanguage, the picker).
// Suspense-throw i18n is OFF: it interacts poorly with the React Compiler and complicates the boot gate.
void i18n.use(initReactI18next).init({
	resources: { en: EN_CATALOGS },
	lng: "en",
	fallbackLng: "en",
	defaultNS: "common",
	returnNull: false,
	interpolation: {
		escapeValue: false // every t() result renders through a React text node, which already escapes.
	},
	react: {
		useSuspense: false
	}
})

// Screen readers, hyphenation and spellcheck read the page language.
i18n.on("languageChanged", language => {
	if (typeof document !== "undefined") {
		document.documentElement.lang = language
	}
})

export { i18n }
