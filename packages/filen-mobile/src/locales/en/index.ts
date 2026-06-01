// English translation catalog — the source language for every other locale.
//
// Per-feature split: each area file (common.ts, appearance.ts, transfers.ts, …) exports an
// `as const` object of its keys; this barrel merges them into ONE flat `translation`
// namespace. Call sites and the type augmentation (src/i18next.d.ts imports `typeof en`)
// stay unchanged across the restructure. Keys MUST be globally unique across all area files
// (truly-shared keys live only in common.ts); a duplicate key name would silently overwrite.
//
// See common.ts for the flat-key format, the `keySeparator:false`/`nsSeparator:false` runtime
// config, and the plural/context separator rule (Risk 1).
import { common } from "@/locales/en/common"
import { appearance } from "@/locales/en/appearance"
import { transfers } from "@/locales/en/transfers"

export const en = {
	...common,
	...appearance,
	...transfers
} as const
