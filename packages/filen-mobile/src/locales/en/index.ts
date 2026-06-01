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
import { auth } from "@/locales/en/auth"
import { chats } from "@/locales/en/chats"
import { contacts } from "@/locales/en/contacts"
import { drive } from "@/locales/en/drive"
import { drivePreview } from "@/locales/en/drivePreview"
import { errors } from "@/locales/en/errors"
import { media } from "@/locales/en/media"
import { misc } from "@/locales/en/misc"
import { notes } from "@/locales/en/notes"
import { security } from "@/locales/en/security"
import { settings } from "@/locales/en/settings"
import { sort } from "@/locales/en/sort"
import { transfers } from "@/locales/en/transfers"

export const en = {
	...common,
	...appearance,
	...auth,
	...chats,
	...contacts,
	...drive,
	...drivePreview,
	...errors,
	...media,
	...misc,
	...notes,
	...security,
	...settings,
	...sort,
	...transfers
} as const
