// Type augmentation that gives `t()`/`i18n.t()` fully type-safe key IntelliSense — a key not
// present in one of the namespaces registered in `@/lib/i18n/catalog` becomes a compile error.
// Reading `resources` off that same object is what stops the augmentation from drifting from the
// set i18next is actually initialized with.
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

import type { EN_CATALOGS } from "@/lib/i18n/catalog"

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "common"
		returnNull: false
		resources: typeof EN_CATALOGS
	}
}
