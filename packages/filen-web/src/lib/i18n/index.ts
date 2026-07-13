import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import { common } from "@/locales/en/common"
import { errors } from "@/locales/en/errors"
import { auth } from "@/locales/en/auth"
import { drive } from "@/locales/en/drive"
import { contacts } from "@/locales/en/contacts"
import { transfers } from "@/locales/en/transfers"
import { preview } from "@/locales/en/preview"
import { notes } from "@/locales/en/notes"
import { chats } from "@/locales/en/chats"
import { settings } from "@/locales/en/settings"
import { publicLinks } from "@/locales/en/publicLinks"
import { audio } from "@/locales/en/audio"

// Consumed by `ActionDef.descriptionKey` (keymap registry) — a compile-time-checked subset
// of the "common" namespace's own key set, derived straight from the catalog so it can never
// drift out of sync with it. `Extract<..., string>` (not `keyof typeof common & string` — flagged
// as a redundant intersection by @typescript-eslint/no-redundant-type-constituents for this
// specific literal-keyed object; identical resulting type, matches the `Extract<>` idiom already
// used in @/stores/boot.ts) guards the same way against a future non-string key.
export type CommonKey = Extract<keyof typeof common, string>

// Same derivation for the "drive" namespace — the keymap registry's first feature-scoped actions
// (drive.*) describe themselves with drive-namespace copy rather than borrowing/duplicating a
// "common" key. Widens `ActionDef.descriptionKey` to `CommonKey | DriveKey`; a future namespace's
// own actions extend the union the same way instead of forcing every description into "common".
export type DriveKey = Extract<keyof typeof drive, string>

// Same derivation for the "contacts" namespace, exported ahead of need: no contacts action
// registers a keymap command yet (lib/keymap/registry.ts's ActionDef.descriptionKey is still
// `CommonKey | DriveKey`), but a later add-contact command can extend that union with this type
// without this file needing a matching edit at that time.
export type ContactsKey = Extract<keyof typeof contacts, string>

// Same derivation for the "transfers" namespace, exported ahead of need: only its own two
// summary-toast keys (features/drive/lib/upload.ts's startUploads) are consumed today, no panel component
// ships yet, but a later transfers-panel keymap command can extend the descriptionKey union with
// this type without this file needing a matching edit at that time.
export type TransfersKey = Extract<keyof typeof transfers, string>

// Same derivation for the "preview" namespace — the pager itself still steps ArrowLeft/ArrowRight
// locally (previewOverlay.tsx's own onKeyDown — a document-level action can't reach a key trapped
// inside the open dialog), but "preview.save" (Cmd/Ctrl+S, scope "editor") does register through the
// keymap registry and describes itself with previewSaveAction, this union's first real consumer.
export type PreviewKey = Extract<keyof typeof preview, string>

// Same derivation for the "notes" namespace, exported ahead of need — no notes action registers a
// keymap command yet, but a later new-note/search command can extend ActionDef.descriptionKey's union
// with this type without this file needing a matching edit then.
export type NotesKey = Extract<keyof typeof notes, string>

// Same derivation for the "chats" namespace, exported ahead of need — no chats action registers a
// keymap command yet, but a later new-chat/search command can extend ActionDef.descriptionKey's union
// with this type without this file needing a matching edit then.
export type ChatsKey = Extract<keyof typeof chats, string>

// Same derivation for the "settings" namespace, exported ahead of need — no settings action
// registers a keymap command yet, but a later one can extend ActionDef.descriptionKey's union
// with this type without this file needing a matching edit then.
export type SettingsKey = Extract<keyof typeof settings, string>

// Same derivation for the "audio" namespace — the audio module's transport shortcuts (scope "audio")
// describe themselves with audio-namespace copy. Exported so ActionDef.descriptionKey's union can
// extend to it without this file needing an edit; the "audio" ActionScope itself lives in the keymap
// registry.
export type AudioKey = Extract<keyof typeof audio, string>

// `Intl.PluralRules` gate: i18next's plural-key resolution (`_one`/
// `_other` suffixes, unused by rev 1's catalogs but load-bearing the moment a count-based key
// lands) needs it. Unlike React Native/Hermes — which mobile polyfills via `intl-pluralrules` —
// every browser capable of `self.crossOriginIsolated` (this app's hard boot floor, gated in
// @/workers/sdk.worker's pre-flight) ships `Intl.PluralRules` natively. No polyfill import here,
// by design.
//
// `resources`/`react.useSuspense`: resources are the EN namespaces only
// — no other language ships yet (multi-language catalogs + `SUPPORTED_LANGUAGES` land with the
// auto-translate pipeline's real script, see .github/workflows/i18n-web.yml). Suspense-throw i18n
// is OFF: it interacts poorly with the React Compiler and complicates the boot gate; revisit only
// if lazy locale loading lands later.
void i18n.use(initReactI18next).init({
	resources: {
		en: {
			common,
			errors,
			auth,
			drive,
			contacts,
			transfers,
			preview,
			notes,
			chats,
			settings,
			publicLinks,
			audio
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
