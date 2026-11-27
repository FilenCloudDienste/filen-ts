import { useEffect } from "react"
import { APP_HELP, rankAppHelp, type AppHelpEntry, type AppHelpWords } from "@filen/shared/assistant"
import { appHelpEntryWords, appHelpLanguages, appHelpShownHere } from "@/lib/appHelp"

// The Settings sidebar's search: the app_help registry's rows this app shows, by their title and description in the
// app's language and in English, ranked as the assistant's help tool ranks them.

export const SETTINGS_SEARCH_RESULTS = 20

interface IndexedSetting {
	entry: AppHelpEntry
	words: AppHelpWords[]
}

// Built on the first search in a language, kept until the language changes.
let index: { language: string; rows: IndexedSetting[] } | null = null

function settingsIndex(language: string): readonly IndexedSetting[] {
	if (index?.language !== language) {
		const languages = appHelpLanguages(language)

		index = {
			language,
			rows: APP_HELP.filter(appHelpShownHere).map(entry => ({ entry, words: appHelpEntryWords(entry, languages) }))
		}
	}

	return index.rows
}

// `language` is the app's current one, which the index's text is read in.
export function searchSettings(query: string, language: string): AppHelpEntry[] {
	return rankAppHelp(settingsIndex(language), query, row => row.words, undefined, SETTINGS_SEARCH_RESULTS).map(row => row.entry)
}

// Pages with a search box of their own (Events, the shortcuts list on Keyboard) take Mod+F (settings.search) for it;
// the sidebar's search takes it everywhere else in Settings.
let pageSearches = 0

export function usePageSearchClaim(active: boolean): void {
	useEffect(() => {
		if (!active) {
			return
		}

		pageSearches += 1

		return () => {
			pageSearches -= 1
		}
	}, [active])
}

export function pageSearchClaimed(): boolean {
	return pageSearches > 0
}
