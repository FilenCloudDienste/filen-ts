import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import { EN_CATALOGS } from "@/lib/i18n/catalog"

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
export type CommonKey = Extract<keyof (typeof EN_CATALOGS)["common"], string>

export type DriveKey = Extract<keyof (typeof EN_CATALOGS)["drive"], string>

export type ContactsKey = Extract<keyof (typeof EN_CATALOGS)["contacts"], string>

export type TransfersKey = Extract<keyof (typeof EN_CATALOGS)["transfers"], string>

export type PreviewKey = Extract<keyof (typeof EN_CATALOGS)["preview"], string>

export type NotesKey = Extract<keyof (typeof EN_CATALOGS)["notes"], string>

export type ChatsKey = Extract<keyof (typeof EN_CATALOGS)["chats"], string>

export type SettingsKey = Extract<keyof (typeof EN_CATALOGS)["settings"], string>

export type AudioKey = Extract<keyof (typeof EN_CATALOGS)["audio"], string>

export type PhotosKey = Extract<keyof (typeof EN_CATALOGS)["photos"], string>

// `Intl.PluralRules` gate: i18next's plural-key resolution (`_one`/
// `_other` suffixes, unused by rev 1's catalogs but load-bearing the moment a count-based key
// lands) needs it. Unlike React Native/Hermes — which mobile polyfills via `intl-pluralrules` —
// every browser capable of `self.crossOriginIsolated` (this app's hard boot floor, gated in
// @/workers/sdk.worker's pre-flight) ships `Intl.PluralRules` natively. No polyfill import here,
// by design.
//
// `resources`/`react.useSuspense`: resources are the EN namespaces only, straight from
// `@/lib/i18n/catalog` — no other language ships yet (multi-language catalogs +
// `SUPPORTED_LANGUAGES` land with the auto-translate pipeline's real script, see
// .github/workflows/i18n-web.yml). Suspense-throw i18n
// is OFF: it interacts poorly with the React Compiler and complicates the boot gate; revisit only
// if lazy locale loading lands later.
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

export { i18n }
