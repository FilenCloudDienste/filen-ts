import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import { common } from "@/locales/en/common"
import { errors } from "@/locales/en/errors"
import { auth } from "@/locales/en/auth"

// Consumed by `ActionDef.descriptionKey` (keymap registry) — a compile-time-checked subset
// of the "common" namespace's own key set, derived straight from the catalog so it can never
// drift out of sync with it. `Extract<..., string>` (not `keyof typeof common & string` — flagged
// as a redundant intersection by @typescript-eslint/no-redundant-type-constituents for this
// specific literal-keyed object; identical resulting type, matches the `Extract<>` idiom already
// used in @/stores/boot.ts) guards the same way against a future non-string key.
export type CommonKey = Extract<keyof typeof common, string>

// `Intl.PluralRules` gate: i18next's plural-key resolution (`_one`/
// `_other` suffixes, unused by rev 1's catalogs but load-bearing the moment a count-based key
// lands) needs it. Unlike React Native/Hermes — which mobile polyfills via `intl-pluralrules` —
// every browser capable of `self.crossOriginIsolated` (this app's hard boot floor, gated in
// @/workers/sdk.worker's pre-flight) ships `Intl.PluralRules` natively. No polyfill import here,
// by design.
//
// `resources`/`react.useSuspense`: resources are the three EN namespaces only
// — no other language ships yet (multi-language catalogs + `SUPPORTED_LANGUAGES` land with the
// auto-translate pipeline's real script, see .github/workflows/i18n-web.yml). Suspense-throw i18n
// is OFF: it interacts poorly with the React Compiler and complicates the boot gate; revisit only
// if lazy locale loading lands later.
void i18n.use(initReactI18next).init({
	resources: {
		en: {
			common,
			errors,
			auth
		}
	},
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
