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
import { photos } from "@/locales/en/photos"
import { archive } from "@/locales/en/archive"

// The app's namespace list and English catalogs, side-effect free. Deliberately NOT `@/lib/i18n`:
// that module runs `i18n.init(…)` at import time, which the translation pipeline (scripts/
// translate-i18n.ts) must not trigger — so both it and the runtime read the list from here instead
// of each restating it. Adding a namespace is one import plus one entry below.
//
// `satisfies`, never a widening annotation: the literal key types survive (i18next.d.ts's
// CustomTypeOptions and every *Key union derive from them) while a catalog that is not a flat string
// record is a compile error.
export const EN_CATALOGS = {
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
	audio,
	photos,
	archive
} satisfies Record<string, Record<string, string>>

export type EnNamespace = keyof typeof EN_CATALOGS

export const EN_NAMESPACES = Object.keys(EN_CATALOGS) as EnNamespace[]
