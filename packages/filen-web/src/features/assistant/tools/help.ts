import { formatBytes } from "@filen/shared"
import {
	APP_HELP,
	APP_HELP_NO_MATCH_NOTE,
	appHelpWords,
	rankAppHelp,
	type AppHelpEntry,
	type AppHelpId,
	type AppHelpSection,
	type AppHelpWords
} from "@filen/shared/assistant"
import { i18n } from "@/lib/i18n"
import type { AppKey } from "@/lib/i18n/appKey"
import { isDesktopApp } from "@/lib/desktop"
import { LOG_RING_MAX } from "@/lib/log"
import { accountQueryGet } from "@/queries/account"
import type { ToolAdapter } from "@/features/assistant/tools/entities"

// app_help over the registry (@filen/shared/assistant appHelp.ts): the bundled text of each setting the Settings pages
// show, searched in the app's language and in English. Built on the first call, freed with the conversation; no
// request.

// The Settings sidebar's label of each section.
const SECTION_LABELS: Readonly<Record<AppHelpSection, AppKey>> = {
	account: "settings:settingsSectionAccount",
	security: "settings:settingsSectionSecurity",
	appearance: "settings:settingsSectionAppearance",
	keyboard: "settings:settingsSectionKeyboard",
	office: "settings:settingsSectionOffice",
	audio: "settings:settingsSectionAudio",
	assistant: "settings:settingsSectionAssistant",
	advanced: "settings:settingsSectionAdvanced",
	billing: "settings:settingsSectionBilling",
	desktop: "settings:settingsSectionDesktop"
}

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

interface IndexedRow {
	entry: AppHelpEntry
	words: AppHelpWords[]
}

let index: { language: string; rows: IndexedRow[] } | null = null

// The rows of this app: the desktop section and desktop-only rows in the desktop app, web-only rows on the web.
function shownHere(entry: AppHelpEntry): boolean {
	return entry.platform === undefined || entry.platform === (isDesktopApp() ? "desktop" : "web")
}

// The registry types its keys as plain "namespace:key" strings, which i18n.t takes with a defaultValue; the registry
// drift test (appHelpRegistry.test.ts) pins that every one exists.

// For searching only, in `language` (the app's when undefined): a figure's placeholder is no word of it.
function searchText(key: string, language?: string): string {
	return i18n.t(key, { defaultValue: "", count: 2, ...(language === undefined ? {} : { lng: language }) }).replace(/\{\{[^}]*\}\}/g, " ")
}

function helpIndex(): IndexedRow[] {
	const language = i18n.language

	if (index?.language !== language) {
		const languages = language === "en" ? [undefined] : [undefined, "en"]

		index = {
			language,
			rows: APP_HELP.filter(shownHere).map(entry => ({
				entry,
				words: languages.map(lng => appHelpWords(searchText(entry.titleKey, lng), searchText(entry.descriptionKey, lng)))
			}))
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

export const appHelpTool: ToolAdapter = (input, scope) => {
	const rows = rankAppHelp(helpIndex(), String(input["query"]), row => row.words)
	const settings = i18n.t("common:settings")

	if (rows.length === 0) {
		return Promise.resolve({ value: { results: [], note: APP_HELP_NO_MATCH_NOTE } })
	}

	return Promise.resolve({
		value: {
			results: rows.map(({ entry }) => {
				const title = i18n.t(entry.titleKey, { defaultValue: "" })
				const text = description(entry)

				return {
					handle: scope.show({ kind: "help", id: entry.id, title }, title),
					title,
					...(text === null ? {} : { description: text }),
					where: `${settings} → ${i18n.t(SECTION_LABELS[entry.section])}`,
					route: entry.route
				}
			})
		}
	})
}

// The registry row an app_help handle names, while this app shows it.
export function shownHelpEntry(id: string): AppHelpEntry | undefined {
	return APP_HELP.find(entry => entry.id === id && shownHere(entry))
}
