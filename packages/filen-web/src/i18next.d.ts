// Type augmentation that gives `t()`/`i18n.t()` fully type-safe key IntelliSense — a key not
// present in the "common" (default), "errors", "auth", "drive", "contacts", "transfers",
// "preview", "notes", "chats", or "settings" namespace becomes a compile error.
//
// MUST live directly under `src/` so tsconfig's `include: ["src"]` (tsconfig.app.json) picks it
// up — mirrors a gotcha from the filen-mobile port (a repo-root `i18next.d.ts` is silently ignored
// there because its tsconfig only includes `src/**/*.d.ts`; ours is broader but the same "must
// live under src/" rule applies).
//
// `keySeparator`/`nsSeparator` are left at i18next's defaults ('.'/':') — unlike mobile, this app
// runs real namespaces addressed via the standard `ns:key` syntax (see errorLabel.ts), so nothing
// here disables them.
import "i18next"

import { type common } from "@/locales/en/common"
import { type errors } from "@/locales/en/errors"
import { type auth } from "@/locales/en/auth"
import { type drive } from "@/locales/en/drive"
import { type contacts } from "@/locales/en/contacts"
import { type transfers } from "@/locales/en/transfers"
import { type preview } from "@/locales/en/preview"
import { type notes } from "@/locales/en/notes"
import { type chats } from "@/locales/en/chats"
import { type settings } from "@/locales/en/settings"

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "common"
		returnNull: false
		resources: {
			common: typeof common
			errors: typeof errors
			auth: typeof auth
			drive: typeof drive
			contacts: typeof contacts
			transfers: typeof transfers
			preview: typeof preview
			notes: typeof notes
			chats: typeof chats
			settings: typeof settings
		}
	}
}
