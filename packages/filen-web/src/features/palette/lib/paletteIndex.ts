import { driveItemName, isDotFilenName, isHiddenName } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { appHelpLanguages, appHelpSearchText, APP_HELP_SECTION_LABELS } from "@/lib/appHelp"
import { ASSISTANT_ACTION_IDS } from "@/lib/keymap/actions"
import { availableOn, CURRENT_PLATFORM, registeredAction } from "@/lib/keymap/registry"
import { liveActionIds } from "@/lib/keymap/liveActions"
import { SHORTCUT_SCOPE_LABEL_KEYS } from "@/lib/keymap/shortcutsCatalog"
import { cachedQueriesWithPrefix } from "@/queries/patch"
import { accountQueryGet } from "@/queries/account"
import { settingsIndex } from "@/features/settings/lib/settingsSearch"
import { SETTINGS_ITEMS } from "@/features/settings/lib/settingsSections"
import {
	DRIVE_LISTING_KEY_PREFIX,
	hideHiddenItemsPreferenceCached,
	showDotFilenPreferenceCached,
	type DriveListingParams
} from "@/features/drive/queries/drive"
import { cachedOwnParents, ownChain } from "@/features/drive/lib/ownAncestry"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { notesQueryGet } from "@/features/notes/queries/notes"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"
import { filterNotesByBlockedOwner } from "@/features/notes/components/notesSidebar.logic"
import { chatsQueryGet } from "@/features/chats/queries/chats"
import { chatTitle, isChatUndecryptable } from "@/features/chats/lib/sort"
import { chatsWithoutBlockedOneOnOne } from "@/features/chats/components/chatsSidebar.logic"
import { heldBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import type { PaletteItem, PaletteText } from "@/features/palette/lib/palette.logic"

// The palette's rows, built when it opens from what the app already holds: the handlers mounted now, the settings
// registry, the cached listings, notes and chats. Never a request.

export const PALETTE_ACTION_ID = "app.commandPalette"

// The actions that go to a place, listed with the places rather than with the actions.
const NAVIGATION_ACTION_IDS: ReadonlySet<string> = new Set([
	"app.openDrive",
	"app.openRecents",
	"app.openFavorites",
	"app.openSharedIn",
	"app.openSharedOut",
	"app.openLinks",
	"app.openTrash",
	"app.openPhotos",
	"app.openVideos",
	"app.openPlaylists",
	"app.openNotes",
	"app.openChats",
	"app.openContacts",
	"app.openTransfers",
	"app.openSync",
	"app.openMounts",
	"app.openSettings"
])

export interface PaletteIndexOptions {
	// Where focus was when the palette opened: an action scoped to an element is offered only from inside it.
	focus: Element | null
	assistantHidden: boolean
}

// A key's text in the app's language and in English, as the settings search reads its rows.
function textsOf(titleKey: string, descriptionKey: string | null): PaletteText[] {
	return appHelpLanguages(i18n.language).map(lng => ({
		title: appHelpSearchText(titleKey, lng),
		description: descriptionKey === null ? "" : appHelpSearchText(descriptionKey, lng)
	}))
}

function actionItems({ focus, assistantHidden }: PaletteIndexOptions): PaletteItem[] {
	const items: PaletteItem[] = []

	for (const id of liveActionIds(focus)) {
		const def = registeredAction(id)

		if (
			def === undefined ||
			id === PALETTE_ACTION_ID ||
			!availableOn(def, CURRENT_PLATFORM) ||
			(assistantHidden && ASSISTANT_ACTION_IDS.has(id))
		) {
			continue
		}

		const navigation = NAVIGATION_ACTION_IDS.has(id)
		const scopeKey = `common:${SHORTCUT_SCOPE_LABEL_KEYS[def.scope]}` as const

		items.push({
			key: `action:${id}`,
			group: navigation ? "navigation" : "actions",
			title: i18n.t(def.descriptionKey),
			...(navigation ? {} : { detail: i18n.t(scopeKey) }),
			actionId: id,
			texts: textsOf(def.descriptionKey, navigation ? null : scopeKey),
			target: { kind: "action", id }
		})
	}

	return items
}

function settingsItems(): PaletteItem[] {
	const detail = i18n.t("common:commandPaletteSettingsDetail")
	const sections: PaletteItem[] = SETTINGS_ITEMS.map(item => ({
		key: `settings:${item.id}`,
		group: "navigation",
		title: i18n.t(`settings:${item.labelKey}`),
		detail,
		texts: textsOf(`settings:${item.labelKey}`, "common:commandPaletteSettingsDetail"),
		target: { kind: "settingsSection", to: item.to }
	}))
	// The settings search's own index: the same rows, in the same languages.
	const settings: PaletteItem[] = settingsIndex(i18n.language).map(({ entry, words }) => ({
		key: `setting:${entry.id}`,
		group: "navigation",
		title: i18n.t(entry.titleKey, { defaultValue: "" }),
		detail: i18n.t(APP_HELP_SECTION_LABELS[entry.section]),
		words,
		queryOnly: true,
		target: { kind: "setting", entry }
	}))

	return [...sections, ...settings]
}

// My Drive's rows as its cached listings hold them, where the cached listings also give the directory chain to open
// them at. Hidden and undecryptable rows are left out as the listings leave them out.
export function driveItems(): PaletteItem[] {
	const hideHidden = hideHiddenItemsPreferenceCached()
	const showDotFilen = showDotFilenPreferenceCached()
	const parentOf = cachedOwnParents()
	const listings: { parent: string | null; rows: readonly DriveItem[] }[] = []
	const names = new Map<string, string>()

	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)) {
		const params = query.queryKey[2] as DriveListingParams
		const rows = query.state.data as readonly DriveItem[] | undefined

		if (params.variant !== "drive" || rows === undefined) {
			continue
		}

		listings.push({ parent: params.uuid, rows })

		for (const row of rows) {
			if (isDirectoryItem(row) && !row.data.undecryptable) {
				names.set(row.data.uuid, driveItemName(row))
			}
		}
	}

	const items: PaletteItem[] = []
	const seen = new Set<string>()
	const rootDetail = i18n.t("common:commandPaletteInDriveRoot")

	for (const { parent, rows } of listings) {
		const chain = parent === null ? [] : ownChain(parent, parentOf)

		// A listing whose way up from the root no cached listing records cannot be opened from here.
		if (parent !== null && chain.length === 0) {
			continue
		}

		const parentName = parent === null ? undefined : names.get(parent)
		const detail = parentName === undefined ? rootDetail : i18n.t("common:commandPaletteInDirectory", { name: parentName })
		const splat = chain.join("/")

		for (const row of rows) {
			const uuid = row.data.uuid

			if (row.data.undecryptable || seen.has(uuid)) {
				continue
			}

			const name = driveItemName(row)

			if ((hideHidden && isHiddenName(name)) || (parent === null && !showDotFilen && isDotFilenName(name))) {
				continue
			}

			seen.add(uuid)

			const directory = isDirectoryItem(row)

			items.push({
				key: `drive:${uuid}`,
				group: "files",
				title: name,
				detail,
				target: directory ? { kind: "directory", splat: splat === "" ? uuid : `${splat}/${uuid}` } : { kind: "file", uuid, splat }
			})
		}
	}

	return items
}

function noteItems(): PaletteItem[] {
	const notes = notesQueryGet()

	if (notes === undefined) {
		return []
	}

	const untitled = i18n.t("notes:noteUntitled")

	return filterNotesByBlockedOwner(notes, heldBlockedUsers())
		.filter(note => !note.trash && !isNoteUndecryptable(note))
		.map(note => ({
			key: `note:${note.uuid}`,
			group: "notes",
			title: note.title !== undefined && note.title.length > 0 ? note.title : untitled,
			target: { kind: "note", uuid: note.uuid }
		}))
}

function chatItems(): PaletteItem[] {
	const chats = chatsQueryGet()

	if (chats === undefined) {
		return []
	}

	const userId = accountQueryGet()?.id
	const undecryptable = i18n.t("common:cannotDecryptTitle")
	const solo = i18n.t("chats:chatJustYou")

	return chatsWithoutBlockedOneOnOne(chats, userId, heldBlockedUsers())
		.filter(chat => !isChatUndecryptable(chat))
		.map(chat => ({
			key: `chat:${chat.uuid}`,
			group: "chats",
			title: chatTitle(chat, userId, undecryptable, solo),
			target: { kind: "chat", uuid: chat.uuid }
		}))
}

export function buildPaletteIndex(options: PaletteIndexOptions): PaletteItem[] {
	return [...actionItems(options), ...settingsItems(), ...driveItems(), ...noteItems(), ...chatItems()]
}
