import { formatBytes } from "@filen/shared"
import {
	APP_HELP,
	APP_HELP_NO_MATCH_NOTE,
	APP_HELP_UNBOUND,
	appHelpWords,
	rankAppHelp,
	type AppHelpEntry,
	type AppHelpId,
	type AppHelpWords
} from "@filen/shared/assistant"
import { i18n } from "@/lib/i18n"
import { APP_HELP_SECTION_LABELS, appHelpEntryWords, appHelpLanguages, appHelpSearchText, appHelpShownHere } from "@/lib/appHelp"
import { LOG_RING_MAX } from "@/lib/log"
import { accountQueryGet } from "@/queries/account"
import { parseCombo } from "@filen/shared/keymap"
import { ALL_ACTIONS } from "@/lib/keymap/actions"
import { availableOn, CURRENT_PLATFORM, currentKeymapRecord, effectiveCombo, type ActionDef, type ActionScope } from "@/lib/keymap/registry"
import { chordText } from "@/lib/keymap/keyText"
import { keyboardLayout } from "@/lib/keymap/layout"
import { SHORTCUT_SCOPE_LABEL_KEYS } from "@/lib/keymap/shortcutsCatalog"
import type { ToolAdapter } from "@/features/assistant/tools/entities"
import { assistantRouter } from "@/features/assistant/tools/navigation"
import { screenOfPath, type AssistantRouteName } from "@/features/assistant/tools/routes"

// app_help over the registry (@filen/shared/assistant appHelp.ts) and the keymap: the bundled text of each setting the
// Settings pages show and the name of each keyboard shortcut, searched in the app's language and in English. Built on
// the first call, freed with the conversation; no request. A shortcut's keys are read at the call, so a key the user
// changed since shows as changed.

type HelpValues = Record<string, string | number>

// The values a description shows its figures with, as its row fills them; null when the app does not hold them, and the
// description is left out rather than shown with a gap.
const DESCRIPTION_VALUES: Partial<Record<AppHelpId, () => HelpValues | null>> = {
	logs: () => ({ count: LOG_RING_MAX }),
	deleteAllItems: () => {
		const account = accountQueryGet()

		return account === undefined ? null : { size: formatBytes(Number(account.storageUsed)) }
	},
	deleteAllVersions: () => {
		const account = accountQueryGet()

		return account === undefined ? null : { count: Number(account.versionedFiles), size: formatBytes(Number(account.versionedStorage)) }
	}
}

type HelpTarget = { kind: "setting"; entry: AppHelpEntry } | { kind: "shortcut"; action: ActionDef }

interface IndexedRow {
	target: HelpTarget
	words: AppHelpWords[]
}

let index: { language: string; rows: IndexedRow[] } | null = null

function helpIndex(): IndexedRow[] {
	const language = i18n.language

	if (index?.language !== language) {
		const languages = appHelpLanguages(language)

		index = {
			language,
			rows: [
				...APP_HELP.filter(appHelpShownHere).map(entry => ({
					target: { kind: "setting" as const, entry },
					words: appHelpEntryWords(entry, languages)
				})),
				// Every shortcut this platform has, by its name, where it works and its hint.
				...ALL_ACTIONS.filter(action => availableOn(action, CURRENT_PLATFORM)).map(action => ({
					target: { kind: "shortcut" as const, action },
					words: languages.map(lng =>
						appHelpWords(
							appHelpSearchText(action.descriptionKey, lng),
							`${appHelpSearchText(SHORTCUT_SCOPE_LABEL_KEYS[action.scope], lng)} ${action.hintKey === undefined ? "" : appHelpSearchText(action.hintKey, lng)}`
						)
					)
				}))
			]
		}
	}

	return index.rows
}

// The conversation ended: its index goes with it.
export function freeAppHelpIndex(): void {
	index = null
}

function description(entry: AppHelpEntry): string | null {
	const fill = DESCRIPTION_VALUES[entry.id]
	const values = fill === undefined ? {} : fill()

	return values === null ? null : i18n.t(entry.descriptionKey, { defaultValue: "", ...values })
}

// A shortcut's keys in effect now (the user's own binding, less single keys while those are off), as the app shows them
// on this platform: "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere; alternatives joined by "or".
export function shortcutKeys(action: ActionDef): string | null {
	const chords = parseCombo(effectiveCombo(action, currentKeymapRecord(), CURRENT_PLATFORM))
	const layout = keyboardLayout()

	return chords.length === 0 ? null : chords.map(chord => chordText(chord, layout)).join(" or ")
}

// The shortcut scope of each screen whose actions have their own: a shortcut several screens name alike (Rename) is
// ranked first for the screen the user is on.
const SCREEN_SCOPES: Partial<Record<AssistantRouteName, ActionScope>> = {
	drive: "drive",
	recents: "drive",
	favorites: "drive",
	shared_with_me: "drive",
	shared_by_me: "drive",
	trash: "drive",
	photos: "photos",
	videos: "videos",
	notes: "notes",
	chats: "chats",
	contacts: "contacts",
	audio: "playlists",
	transfers: "transfers",
	sync: "sync",
	mounts: "mounts"
}

function currentScope(): ActionScope | undefined {
	const pathname = assistantRouter()?.state.location.pathname
	const screen = pathname === undefined ? "other" : screenOfPath(pathname)

	return screen === "other" ? undefined : (SCREEN_SCOPES[screen] ?? (screen.startsWith("settings") ? "settings" : undefined))
}

export const appHelpTool: ToolAdapter = (input, scope) => {
	const here = currentScope()
	const rows = rankAppHelp(
		helpIndex(),
		String(input["query"]),
		row => row.words,
		row => row.target.kind === "shortcut" && row.target.action.scope === here
	)
	const settings = i18n.t("common:settings")

	if (rows.length === 0) {
		return Promise.resolve({ value: { results: [], note: APP_HELP_NO_MATCH_NOTE } })
	}

	return Promise.resolve({
		value: {
			results: rows.map(({ target }) => {
				if (target.kind === "shortcut") {
					const { action } = target

					return {
						shortcut: i18n.t(action.descriptionKey, { defaultValue: "" }),
						keys: shortcutKeys(action) ?? APP_HELP_UNBOUND,
						where: i18n.t(SHORTCUT_SCOPE_LABEL_KEYS[action.scope]),
						...(action.hintKey === undefined ? {} : { when: i18n.t(action.hintKey, { defaultValue: "" }) }),
						// Where it can be changed.
						route: "settings_keyboard"
					}
				}

				const { entry } = target
				const title = i18n.t(entry.titleKey, { defaultValue: "" })
				const text = description(entry)

				return {
					handle: scope.show({ kind: "help", id: entry.id, title }, title),
					title,
					...(text === null ? {} : { description: text }),
					where: `${settings} → ${i18n.t(APP_HELP_SECTION_LABELS[entry.section])}`,
					route: entry.route
				}
			})
		}
	})
}

// The registry row an app_help handle names, while this app shows it.
export function shownHelpEntry(id: string): AppHelpEntry | undefined {
	return APP_HELP.find(entry => entry.id === id && appHelpShownHere(entry))
}
