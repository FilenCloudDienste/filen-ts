// Type augmentation that gives `t()` fully type-safe key IntelliSense — both from
// `useTranslation().t` and the module-level `t` exported by src/lib/i18n.ts. A wrong key
// becomes a compile error.
//
// MUST live under `src/` so tsconfig's `src/**/*.d.ts` include glob picks it up. A repo-root
// `i18next.d.ts` is silently ignored (not in `include`) and the types never apply.
//
// `keySeparator: false` here makes the type system treat catalog keys as FLAT literals,
// matching the runtime config in src/lib/i18n.ts.
import "i18next"

import { type en } from "@/locales/en"

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation"
		resources: { translation: typeof en }
		keySeparator: false
	}
}
