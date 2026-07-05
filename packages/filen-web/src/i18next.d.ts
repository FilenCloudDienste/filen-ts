// Type augmentation that gives `t()`/`i18n.t()` fully type-safe key IntelliSense — a key not
// present in the "common" (default) or "errors" namespace becomes a compile error.
//
// MUST live directly under `src/` so tsconfig's `include: ["src"]` (tsconfig.app.json) picks it
// up — mirrors a documented gotcha from the filen-mobile port (a repo-root `i18next.d.ts` is
// silently ignored there because its tsconfig only includes `src/**/*.d.ts`; ours is broader but
// the same "must live under src/" rule applies) — see docs/research/mobile/i18n-theme.md §1.2.
//
// `keySeparator`/`nsSeparator` are left at i18next's defaults ('.'/':') — unlike mobile, this app
// runs two real namespaces addressed via the standard `ns:key` syntax (see errorLabel.ts), so
// nothing here disables them.
import "i18next"

import { type common } from "@/locales/en/common"
import { type errors } from "@/locales/en/errors"

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "common"
		returnNull: false
		resources: {
			common: typeof common
			errors: typeof errors
		}
	}
}
